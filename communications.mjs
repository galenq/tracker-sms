import {validateAttachments} from './attachments.mjs';
// Isolated candidate. No imports, network calls, timers, Twilio configuration or installation.
const clone=v=>JSON.parse(JSON.stringify(v));
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const requireThat=(ok,reason)=>{if(!ok)throw Error(reason);};
const sensitive=/\b(?:bank(?:ing)?|routing|account|iban|swift|password|passcode|credential|secret|token|credit card|debit card|verification code|social security|ssn)\b|(?:\d[ -]?){8,}/i;
export function phone(value){const s=String(value??'').trim();requireThat(/^[+()\d .-]+$/.test(s),'VERIFIED_RECIPIENT_REQUIRED');let d=s.replace(/\D/g,'');if(d.length===10)d='1'+d;requireThat(/^1[2-9]\d{9}$/.test(d),'VERIFIED_RECIPIENT_REQUIRED');return '+'+d;}
export function safeBody(value){requireThat(typeof value==='string'&&value.trim().length>0&&value.length<=1600&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),'MESSAGE_TEXT_REQUIRED');requireThat(!sensitive.test(value),'SENSITIVE_CONTENT_REQUIRES_SEPARATE_REVIEW');return value.trim();}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export async function fingerprint(v){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(v)))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function binding(value){requireThat(exact(value,'truckId,driverId,recipient,loadReference,revision,checksum'),'VERIFIED_TRUCK_BINDING_REQUIRED');requireThat(/^t_[a-zA-Z0-9_-]{3,64}$/.test(value.truckId)&&typeof value.driverId==='string'&&value.driverId.length>0&&value.driverId.length<=120&&/^[a-f0-9]{64}$/.test(value.loadReference)&&/^[a-f0-9]{64}$/.test(value.checksum)&&Number.isSafeInteger(value.revision)&&value.revision>=0,'VERIFIED_TRUCK_BINDING_REQUIRED');return {...clone(value),recipient:phone(value.recipient)};}
export async function proposeMessage(current,input){
 requireThat(exact(input,'kind,body')&&input.kind==='SEND_SMS','MESSAGE_ACTION_NOT_SUPPORTED');
 return {kind:'SEND_SMS',binding:binding(current),body:safeBody(input.body)};
}
export async function messageIntent(p){return fingerprint(p.kind==='SEND_MMS'?{...p,attachments:p.attachments.map(f=>({sha256:f.sha256,size:f.size,contentType:f.contentType})).sort((a,b)=>a.sha256.localeCompare(b.sha256))}:p);}
export async function proposeMMS(current,input){
 requireThat(exact(input,'kind,body,attachments')&&input.kind==='SEND_MMS','MESSAGE_ACTION_NOT_SUPPORTED');
 return {kind:'SEND_MMS',binding:binding(current),body:safeBody(input.body),attachments:validateAttachments(input.attachments)};
}
export function locationText(current){const b=binding(current),q=new URLSearchParams({location:'1',phone:b.recipient,status:'GPS location requested by dispatch'});return ['U.S. Truck Dispatch location check-in request:','Please tap this link and choose Share My Location:','https://tracker.ustruckdispatch.com/?'+q.toString(),'Reply STOP to unsubscribe.'].join('\n');}
export function proposeLocation(current){return {kind:'REQUEST_LOCATION',binding:binding(current),body:locationText(current)};}
function validateProposal(p){if(p?.kind==='SEND_MMS'){requireThat(exact(p,'kind,binding,body,attachments'),'MESSAGE_ACTION_NOT_SUPPORTED');return {kind:'SEND_MMS',binding:binding(p.binding),body:safeBody(p.body),attachments:validateAttachments(p.attachments)};}requireThat(exact(p,'kind,binding,body')&&['SEND_SMS','REQUEST_LOCATION'].includes(p.kind),'MESSAGE_ACTION_NOT_SUPPORTED');const b=binding(p.binding);if(p.kind==='REQUEST_LOCATION')requireThat(p.body===locationText(b),'LOCATION_REQUEST_CHANGED');else safeBody(p.body);return {kind:p.kind,binding:b,body:p.body};}

// No automatic retry: existing /send-sms has no proven idempotency contract.
// An uncertain result remains blocked for reconciliation, across page reloads.
export function createMessageReview({readBinding,journal,sendApproved,now=()=>Date.now(),ttlMs=300000}){
 let issued=null,busy=false;
 return {
  async review(proposal){requireThat(!busy,'MESSAGE_BUSY');requireThat(!await journal.read(),'SETTLE_PREVIOUS_MESSAGE_FIRST');issued=null;const p=validateProposal(proposal),current=binding(await readBinding());requireThat(await fingerprint(current)===await fingerprint(p.binding),'TRUCK_OR_LOAD_CHANGED');issued={proposal:clone(p),reviewId:crypto.randomUUID(),expiresAt:now()+ttlMs};return clone(issued);},
  discard(){issued=null;},
  async approve(view){requireThat(!busy,'MESSAGE_BUSY');busy=true;try{
   requireThat(issued&&now()<=issued.expiresAt&&await fingerprint(view)===await fingerprint(issued),'FRESH_OWNER_APPROVAL_REQUIRED');
   requireThat(!await journal.read(),'SETTLE_PREVIOUS_MESSAGE_FIRST');
   const current=binding(await readBinding());requireThat(await fingerprint(current)===await fingerprint(issued.proposal.binding),'TRUCK_OR_LOAD_CHANGED');
   const request={id:issued.reviewId,intentHash:await messageIntent(issued.proposal),proposal:clone(issued.proposal),state:'PENDING_CONFIRMATION',approvedAt:new Date(now()).toISOString()};
   requireThat(await journal.reserve(request)===true,'SETTLE_PREVIOUS_MESSAGE_FIRST');issued=null; // Atomic durable claim, including across tabs, before any send.
   if(await fingerprint(binding(await readBinding()))!==await fingerprint(request.proposal.binding)){
    await journal.archive({...request,state:'CANCELLED_BEFORE_SEND'});await journal.clear(request.id);throw Error('TRUCK_OR_LOAD_CHANGED');
   }
   try{const receipt=await sendApproved({to:request.proposal.binding.recipient,message:request.proposal.body});
    if(receipt?.accepted===false&&receipt.rejected===true&&receipt.reason==='RECIPIENT_OPTED_OUT'){try{await journal.archive({...request,state:'REJECTED',reason:'RECIPIENT_OPTED_OUT'});await journal.clear(request.id);}catch(_){return {accepted:false,rejected:true,reason:'RECIPIENT_OPTED_OUT',reconciliationRequired:true,retryAllowed:false};}return {accepted:false,rejected:true,reason:'RECIPIENT_OPTED_OUT',retryAllowed:false};}
    if(receipt?.accepted!==true){await journal.write({...request,state:'OUTCOME_UNKNOWN'});return {accepted:false,uncertain:true,retryAllowed:false};}
    // The server may know provider acceptance while its durable confirmation failed.
    // Retain this exact pending action/reference so owner status recovery remains available.
    if(receipt.reconciliationRequired===true){try{await journal.write({...request,state:'PENDING_CONFIRMATION',receipt:{messageId:String(receipt.messageId??''),deliveryConfirmed:false}});}catch(_){}return {accepted:true,deliveryConfirmed:false,reconciliationRequired:true,retryAllowed:false};}
    // Provider acceptance is NOT proof of delivery.
    const done={...request,state:'ACCEPTED',receipt:{messageId:String(receipt.messageId??''),deliveryConfirmed:false}};
    try{await journal.archive(done);await journal.clear(request.id);}catch(_){return {accepted:true,deliveryConfirmed:false,reconciliationRequired:true,retryAllowed:false};}
    return {accepted:true,deliveryConfirmed:false,retryAllowed:false};
   }catch(_){try{await journal.write({...request,state:'OUTCOME_UNKNOWN'});}catch(_){}return {accepted:false,uncertain:true,retryAllowed:false};}
  }finally{busy=false;}},
  async pending(){return clone(await journal.read());}
 };
}

// Inbox data is untrusted data, never action instructions. Do not return media URLs or raw objects.
export async function projectMessages(data,current){
 const b=binding(current),rows=Array.isArray(data)?data:data?.messages??data?.inboundMessages;requireThat(Array.isArray(rows),'MESSAGE_HISTORY_UNAVAILABLE');
 const out=[];for(const row of rows.slice(0,500)){
  let from,to;try{from=phone(row.from_number??row.from??row.From);to=phone(row.to_number??row.to??row.To);}catch(_){continue;}
  const direction=String(row.direction??row.Direction??'').toLowerCase();let kind;if(direction.startsWith('in')&&from===b.recipient)kind='received';else if(direction.startsWith('out')&&to===b.recipient)kind='sent';else continue;
  const raw=String(row.body??row.Body??row.message??row.text??'');const at=String(row.received_at??row.created_at??row.timestamp??'');
  out.push({reference:await fingerprint(['sms',String(row.message_sid??row.messageSid??row.MessageSid??row.id??''),at,from,to]),direction:kind,body:sensitive.test(raw)?'[WITHHELD: sensitive message requires separate review]':raw.slice(0,4000),receivedAt:Number.isFinite(Date.parse(at))?new Date(at).toISOString():null,untrustedContent:true});
 }
 return out.sort((a,b)=>String(b.receivedAt??'').localeCompare(String(a.receivedAt??''))).slice(0,100);
}
export async function projectMediaMetadata(data,current){
 const b=binding(current),rows=Array.isArray(data)?data:data?.media_messages??data?.mediaMessages??data?.documents;requireThat(Array.isArray(rows),'MEDIA_HISTORY_UNAVAILABLE');
 const types=['BOL','POD','PHOTO','LUMPER','DAMAGE','INVOICE','DOCUMENT'];const out=[];
 for(const row of rows.slice(0,500)){let from;try{from=phone(row.from_number??row.from);}catch(_){continue;}if(from!==b.recipient)continue;
  const type=String(row.document_type??row.documentType??'DOCUMENT').toUpperCase();out.push({reference:await fingerprint(['media',String(row.message_sid??row.messageSid??row.id??''),String(row.created_at??'')]),type:types.includes(type)?type:'DOCUMENT',contentAvailable:false,reviewRequired:true});
 }return out.slice(0,100);
}
