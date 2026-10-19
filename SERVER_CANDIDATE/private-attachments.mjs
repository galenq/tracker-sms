import {createHash,randomUUID} from 'node:crypto';
import {validateAttachments,extension,FILE_LIMIT,PDF_LIMIT} from '../attachments.mjs';
const OWNER='f3208b50-b621-444e-a048-76c889a38acc';
export const ATTACHMENT_BUCKET='ustd-jack-outbound-private';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function checkBytes(bytes,type){
 if(!Buffer.isBuffer(bytes)||!extension(type)||bytes.length<1||bytes.length>(type==='application/pdf'?PDF_LIMIT:FILE_LIMIT))throw Error('ATTACHMENT_INVALID');
 const valid=type==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):type==='image/jpeg'?bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,5).toString()==='%PDF-';
 if(!valid)throw Error('ATTACHMENT_CONTENT_TYPE_MISMATCH');
}
// This bucket must be private, with no browser/anon policies. Only this server uploads.
// No update/delete routes or upsert: an approved object's identity cannot be overwritten.
export function createPrivateAttachments({supabase,storageOrigin}){
 const origin=new URL(storageOrigin).origin;if(!origin.startsWith('https://'))throw Error('PRIVATE_STORAGE_REQUIRED');
 const bucket=supabase.storage.from(ATTACHMENT_BUCKET);
 const privateOnly=async()=>{const {data,error}=await supabase.storage.getBucket(ATTACHMENT_BUCKET);if(error||data?.id!==ATTACHMENT_BUCKET||data.public!==false)throw Error('PRIVATE_STORAGE_REQUIRED');};
 return {
  async stage({bytes,contentType,confirmedNoSensitiveContent}){
   if(confirmedNoSensitiveContent!==true)throw Error('OWNER_FILE_REVIEW_REQUIRED');
   checkBytes(bytes,contentType);await privateOnly();const sha256=digest(bytes),ext=extension(contentType);
   const manifest={objectKey:OWNER+'/'+randomUUID()+'/'+sha256+'.'+ext,sha256,size:bytes.length,contentType,fileName:'attachment.'+ext};
   const {error}=await bucket.upload(manifest.objectKey,bytes,{upsert:false,contentType,cacheControl:'0'});
   if(error)throw Error('PRIVATE_ATTACHMENT_UPLOAD_UNCONFIRMED');return manifest;
  },
  async verify(files){
   await privateOnly();
   for(const f of validateAttachments(files)){
    const {data,error}=await bucket.download(f.objectKey);if(error||!data||data.size!==f.size)throw Error('ATTACHMENT_CHANGED_OR_UNAVAILABLE');
    const bytes=Buffer.from(await data.arrayBuffer());checkBytes(bytes,f.contentType);
    if(digest(bytes)!==f.sha256)throw Error('ATTACHMENT_CHANGED_OR_UNAVAILABLE');
   }
  },
  async signedForProvider(files){
   // Called only after durable approval reservation. Short-lived capabilities go to Twilio only.
   await this.verify(files);const urls=[];
   for(const f of validateAttachments(files)){
    const {data,error}=await bucket.createSignedUrl(f.objectKey,600);
    if(error||!data?.signedUrl)throw Error('PRIVATE_ATTACHMENT_LINK_UNAVAILABLE');
    const url=new URL(data.signedUrl),path='/storage/v1/object/sign/'+ATTACHMENT_BUCKET+'/'+f.objectKey;
    if(url.origin!==origin||url.pathname!==path||!url.searchParams.get('token')||url.username||url.password)throw Error('PRIVATE_ATTACHMENT_LINK_UNAVAILABLE');
    urls.push(url.toString());
   }return urls;
  }
 };
}
export function mountAttachmentRoutes({app,verifyUser,assets,bodyParser,isEnabled}){
 if(typeof bodyParser!=='function')throw Error('ATTACHMENT_PARSER_REQUIRED');
 // Authentication precedes the larger, route-specific binary parser. Legacy JSON limits stay intact.
 app.post('/jack-attachment-stage',async(req,res,next)=>{
  try{const h=req.headers.authorization;if(typeof h!=='string'||!/^Bearer [^\s]+$/.test(h)||(await verifyUser(h.slice(7)))?.id!==OWNER)throw Error('OWNER_REQUIRED');
   if(!isEnabled())return res.status(409).json({error:'MMS_DISABLED'});
   if(req.headers['x-ustd-confirm-no-sensitive-content']!=='true')return res.status(409).json({error:'OWNER_FILE_REVIEW_REQUIRED'});
   next();
  }catch(_){res.status(403).json({error:'OWNER_REQUIRED'});}
 },bodyParser,async(req,res)=>{
  try{if(!isEnabled())throw Error('MMS_DISABLED');const asset=await assets.stage({bytes:req.body,contentType:req.headers['content-type'],confirmedNoSensitiveContent:true});res.json({asset,sent:false});}
  catch(_){res.status(409).json({error:'ATTACHMENT_UPLOAD_UNCONFIRMED',sent:false});}
 },(err,req,res,next)=>{res.status(err?.type==='entity.too.large'?413:400).json({error:'ATTACHMENT_UPLOAD_UNCONFIRMED',sent:false});});
}
