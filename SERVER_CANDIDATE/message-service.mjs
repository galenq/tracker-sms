import {fingerprint,messageIntent,proposeMessage,proposeMMS,proposeLocation} from '../communications.mjs';
import {bindingFromTracker} from '../tracker-adapter.mjs';
import {prepare} from '../CONNECTOR_CANDIDATE/ustd-jack-mcp/operational-codec.mjs';
import {legacySMSReceipt} from '../legacy-sms-receipt.mjs';
const OWNER='f3208b50-b621-444e-a048-76c889a38acc';
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')===keys.split(',').sort().join(',');
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
const clone=x=>JSON.parse(JSON.stringify(x));
// Network and persistence adapters must be explicitly injected by an authenticated server.
// This module is NOT registered in any deployed function or Render route.
export function createApprovedMessageService({verifyUser,readCanonical,store,sendOnce,readProviderReceipt,isSendingEnabled=()=>true,bindingFromCanonical=bindingFromTracker,newReviewId=()=>crypto.randomUUID(),verifyAttachments=async()=>{throw Error('PRIVATE_ATTACHMENTS_REQUIRED');},isMMSEnabled=()=>false}){
 const owner=async token=>need((await verifyUser(token))?.id===OWNER,'OWNER_REQUIRED');
 async function current(token,proposal){await owner(token);const c=await readCanonical(token);const packed=await prepare(c.snapshot);need(packed.checksum===c.checksum,'VERIFIED_CANONICAL_READ_REQUIRED');const b=await bindingFromCanonical(c,proposal.binding.truckId);need(await fingerprint(b)===await fingerprint(proposal.binding),'TRUCK_OR_LOAD_CHANGED');return b;}
 const mediaReady=async p=>{if(p.kind==='SEND_MMS'){need(isMMSEnabled()===true,'MMS_DISABLED');await verifyAttachments(p.attachments);need(isMMSEnabled()===true,'MMS_DISABLED');}};
 const output=r=>({reviewId:r.id,reviewHash:r.review_hash,proposal:clone(r.proposal),expiresAt:r.expires_at,ownerApprovalRequired:true,sent:false,sendingEnabled:isSendingEnabled()===true});
 return {
  async review(token,proposal){
   need(exact(proposal,proposal?.kind==='SEND_MMS'?'kind,binding,body,attachments':'kind,binding,body'),'MESSAGE_ACTION_NOT_SUPPORTED');
   const b=await current(token,proposal);let p;if(proposal.kind==='SEND_SMS')p=await proposeMessage(b,{kind:'SEND_SMS',body:proposal.body});else if(proposal.kind==='SEND_MMS')p=await proposeMMS(b,{kind:'SEND_MMS',body:proposal.body,attachments:proposal.attachments});else{need(proposal.kind==='REQUEST_LOCATION','MESSAGE_ACTION_NOT_SUPPORTED');p=proposeLocation(b);}
   need(await fingerprint(p)===await fingerprint(proposal),'MESSAGE_REVIEW_CHANGED');
   await mediaReady(p);
   const id=newReviewId(),reviewHash=await fingerprint([id,p]);
   // Server-computed intent hash prevents alternate review IDs bypassing duplicate protection.
   const row=await store.create({id,owner_id:OWNER,truck_id:b.truckId,intent_hash:await messageIntent(p),review_hash:reviewHash,proposal:p});
   return output(row);
  },
  async approve(token,approval){
   await owner(token);need(exact(approval,'reviewId,reviewHash'),'EXACT_OWNER_APPROVAL_REQUIRED');
   const row=await store.read(OWNER,approval.reviewId);need(row&&row.review_hash===approval.reviewHash,'EXACT_OWNER_APPROVAL_REQUIRED');
   await current(token,row.proposal);await mediaReady(row.proposal);need(isSendingEnabled()===true,'MESSAGE_SENDING_DISABLED');
   const reserved=await store.reserve(OWNER,row.id,row.review_hash);need(reserved,'APPROVAL_USED_EXPIRED_OR_PREVIOUS_MESSAGE_UNSETTLED');
   // No network call to the sender occurs until reservation is durably committed.
   try{await current(token,reserved.proposal);await mediaReady(reserved.proposal);if(reserved.proposal.kind==='SEND_MMS'){await current(token,reserved.proposal);need(isMMSEnabled()===true,'MMS_DISABLED');}need(isSendingEnabled()===true,'MESSAGE_SENDING_DISABLED');}catch(e){await store.cancelBeforeSend(OWNER,row.id);throw e;}
   let receipt,definiteOptOut=false;
   try{const response=await sendOnce({to:reserved.proposal.binding.recipient,message:reserved.proposal.body,...(reserved.proposal.kind==='SEND_MMS'?{attachments:reserved.proposal.attachments}:{})},{reviewId:row.id,reviewHash:row.review_hash});definiteOptOut=response.status===400&&response.body?.success===false&&response.body?.notAccepted===true&&response.body?.code==='RECIPIENT_OPTED_OUT';receipt=legacySMSReceipt(response.status,response.body);}catch(_){receipt={accepted:false,uncertain:true,retryAllowed:false};}
   if(definiteOptOut){try{await store.rejectOptOut(OWNER,row.id);return {accepted:false,rejected:true,reason:'RECIPIENT_OPTED_OUT',retryAllowed:false};}catch(_){return {accepted:false,uncertain:true,retryAllowed:false};}}
   if(!receipt.accepted){try{const settled=await store.read(OWNER,row.id);if(settled?.state==='ACCEPTED')return {accepted:true,messageId:settled.message_id,deliveryConfirmed:settled.provider_status==='delivered',retryAllowed:false};}catch(_){}try{await store.unknown(OWNER,row.id);}catch(_){}return {accepted:false,uncertain:true,retryAllowed:false};}
   try{await store.accept(OWNER,row.id,receipt.messageId);}catch(_){return {accepted:true,messageId:receipt.messageId,deliveryConfirmed:false,reconciliationRequired:true,retryAllowed:false};}
   return {accepted:true,messageId:receipt.messageId,deliveryConfirmed:false,retryAllowed:false};
  },
  async status(token,id){await owner(token);const r=await store.read(OWNER,id);need(r,'MESSAGE_REVIEW_NOT_FOUND');return {reviewId:r.id,reviewHash:r.review_hash,proposalHash:await fingerprint(r.proposal),state:r.state,messageId:r.message_id??null,providerStatus:r.provider_status??null,reason:r.failure_code??null,deliveryConfirmed:r.provider_status==='delivered',retryAllowed:false};},
  async reconcile(token,{reviewId,messageId}){
   await owner(token);need(typeof readProviderReceipt==='function','AUTHORITATIVE_RECEIPT_LOOKUP_REQUIRED');need(/^(SM|MM)[a-fA-F0-9]{32}$/.test(messageId??''),'AUTHORITATIVE_RECEIPT_REQUIRED');
   const row=await store.read(OWNER,reviewId);need(row&&['RESERVED','UNKNOWN'].includes(row.state),'UNSETTLED_MESSAGE_REQUIRED');
   // Only a server-side provider lookup can supply this receipt; never accept browser history as evidence.
   need(row.proposal.kind!=='SEND_MMS','MMS_REQUIRES_SIGNED_CALLBACK');
   const proof=await readProviderReceipt(messageId);
   // Exact request correlation is mandatory. Matching phone/body/time alone is NOT proof.
   // Legacy SMS history does not provide this correlation, so cannot resolve uncertainty.
   need(proof?.requestId===row.id&&proof.sid===messageId&&proof.direction==='outbound-api'&&proof.to===row.proposal.binding.recipient&&proof.body===row.proposal.body&&Number.isFinite(Date.parse(proof.createdAt))&&Date.parse(proof.createdAt)>=Date.parse(row.claimed_at)&&Date.parse(proof.createdAt)<=Date.parse(row.claimed_at)+300000,'AUTHORITATIVE_RECEIPT_MISMATCH');
   // Accepted outcomes only: absence from history never clears a reservation or authorizes resend.
   await store.accept(OWNER,row.id,messageId);return {accepted:true,messageId,deliveryConfirmed:false,retryAllowed:false};
  }
 };
}
