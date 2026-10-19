const ORIGIN='https://tracker-sms.onrender.com',OWNER='f3208b50-b621-444e-a048-76c889a38acc';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function callbackURL({reviewId,reviewHash}){if(!uuid.test(reviewId??'')||!/^[a-f0-9]{64}$/.test(reviewHash??''))throw Error('MESSAGE_CALLBACK_BINDING_REQUIRED');const u=new URL('/jack-sms-status',ORIGIN);u.searchParams.set('review_id',reviewId);u.searchParams.set('review_hash',reviewHash);return u.toString();}
// Reuse the existing initialized Twilio client and sender number, never retrieve secrets into the UI.
export function createTwilioMessageSender({client,from}){return async({to,message},approval)=>{try{const r=await client.messages.create({to,from,body:message,statusCallback:callbackURL(approval)});return {status:200,body:{success:true,sid:r.sid}};}catch(e){if(e?.status===400&&e?.code===21610)return {status:400,body:{success:false,notAccepted:true,code:'RECIPIENT_OPTED_OUT'}};throw e;}};}
// An additive, isolated route candidate. Does not replace existing inbound SMS/MMS or status webhooks.
export function createTwilioStatusHandler({validateRequest,authToken,accountSid,from,store}){
 return async({originalUrl,signature,body})=>{
  if(typeof originalUrl!=='string'||!originalUrl.startsWith('/jack-sms-status?')||typeof signature!=='string'||!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_PROVIDER_CALLBACK');
  const u=new URL(originalUrl,ORIGIN),id=u.searchParams.get('review_id'),hash=u.searchParams.get('review_hash');
  if(u.toString()!==callbackURL({reviewId:id,reviewHash:hash})||!validateRequest(authToken,signature,u.toString(),body))throw Error('INVALID_PROVIDER_CALLBACK');
  if(body.AccountSid!==accountSid||body.From!==from||!/^SM[a-fA-F0-9]{32}$/.test(body.MessageSid??'')||!['queued','sending','sent','delivered','undelivered','failed'].includes(body.MessageStatus))throw Error('INVALID_PROVIDER_CALLBACK');
  const row=await store.read(OWNER,id);
  if(!row||row.review_hash!==hash||body.To!==row.proposal.binding.recipient)throw Error('PROVIDER_CALLBACK_BINDING_MISMATCH');
  await store.callback(OWNER,id,hash,body.MessageSid,body.MessageStatus);
  return {status:200};
 };
}
