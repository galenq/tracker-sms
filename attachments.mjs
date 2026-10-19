// Shared metadata only. File bytes and signed URLs never enter Jack's tool output.
export const FILE_LIMIT=4000000, TOTAL_LIMIT=4500000, PDF_LIMIT=500000;
const OWNER='f3208b50-b621-444e-a048-76c889a38acc';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const keyPattern=new RegExp('^'+OWNER+'/('+uuid+')/([a-f0-9]{64})\\.(png|jpg|pdf)$');
const extensions={'image/png':'png','image/jpeg':'jpg','application/pdf':'pdf'};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function validateAttachments(files){
 if(!Array.isArray(files)||files.length<1||files.length>10)throw Error('ATTACHMENT_REQUIRED');
 let total=0;const paths=new Set();
 return files.map(f=>{
  if(!exact(f,'objectKey,sha256,size,contentType,fileName')||!extensions[f.contentType]||!Number.isSafeInteger(f.size)||f.size<1||f.size>(f.contentType==='application/pdf'?PDF_LIMIT:FILE_LIMIT)||!/^[a-f0-9]{64}$/.test(f.sha256??'')||typeof f.fileName!=='string'||!/^[a-zA-Z0-9_-]{1,15}\.(png|jpg|pdf)$/.test(f.fileName))throw Error('ATTACHMENT_INVALID');
  const match=typeof f.objectKey==='string'&&f.objectKey.match(keyPattern);
  if(!match||match[2]!==f.sha256||match[3]!==extensions[f.contentType]||!f.fileName.endsWith('.'+match[3])||paths.has(f.objectKey))throw Error('ATTACHMENT_INVALID');
  paths.add(f.objectKey);total+=f.size;if(total>TOTAL_LIMIT)throw Error('ATTACHMENTS_TOO_LARGE');
  return {...f};
 });
}
export function extension(contentType){return extensions[contentType];}
