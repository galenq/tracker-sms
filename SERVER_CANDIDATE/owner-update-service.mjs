import {createApprovedMessageService} from './message-service.mjs';
import {phone,safeBody,proposeMessage,fingerprint} from '../communications.mjs';
import {prepare} from '../CONNECTOR_CANDIDATE/ustd-jack-mcp/operational-codec.mjs';
const OWNER='f3208b50-b621-444e-a048-76c889a38acc';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const exact=x=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join(',')==='baseline_checksum,expected_revision,message,request_id';
// A separate standing-permission path, never a bypass for the driver/broker review route.
// The destination comes only from the server's owner configuration, never tool arguments.
export function createOwnerUpdateService({verifyUser,readCanonical,store,sendOnce,ownerRecipient,isSendingEnabled}){
 const recipient=phone(ownerRecipient);
 if(typeof isSendingEnabled!=='function')throw Error('OWNER_UPDATE_CONFIG_REQUIRED');
 // Journal namespace only: this is not a Tracker truck and creates no truck or invoice.
 const stream='t_owner_updates';
 const ownerBinding=async(current,streamId)=>{if(streamId!==stream)throw Error('OWNER_UPDATE_STREAM_REQUIRED');return {truckId:stream,driverId:await fingerprint([OWNER,recipient]),recipient,loadReference:await fingerprint(['OWNER_ROUTINE_UPDATES']),revision:current.revision,checksum:current.checksum};};
 const owner=async token=>{if((await verifyUser(token))?.id!==OWNER)throw Error('OWNER_REQUIRED');};
 return {
  async send(token,input){
   await owner(token);if(isSendingEnabled()!==true)throw Error('OWNER_UPDATES_DISABLED');
   if(!exact(input)||!uuid.test(input.request_id??'')||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0||!/^[a-f0-9]{64}$/.test(input.baseline_checksum??''))throw Error('OWNER_UPDATE_REQUEST_INVALID');
   const message=safeBody(input.message),current=await readCanonical(token),packed=await prepare(current.snapshot);
   if(packed.checksum!==current.checksum)throw Error('VERIFIED_CANONICAL_READ_REQUIRED');
   if(current.revision!==input.expected_revision||current.checksum!==input.baseline_checksum)throw Error('OWNER_UPDATE_BASELINE_CHANGED');
   const proposal=await proposeMessage(await ownerBinding(current,stream),{kind:'SEND_SMS',body:message});
   const service=createApprovedMessageService({verifyUser,readCanonical,store,sendOnce,isSendingEnabled,bindingFromCanonical:ownerBinding,newReviewId:()=>input.request_id});
   const review=await service.review(token,proposal);
   const receipt=await service.approve(token,{reviewId:review.reviewId,reviewHash:review.reviewHash});
   return {requestId:input.request_id,...receipt};
  },
  async status(token,id){
   await owner(token);if(!uuid.test(id??''))throw Error('OWNER_UPDATE_REQUEST_INVALID');
   const row=await store.read(OWNER,id);if(!row||row.proposal?.binding?.recipient!==recipient)throw Error('OWNER_UPDATE_NOT_FOUND');
   const service=createApprovedMessageService({verifyUser,readCanonical,store,sendOnce,isSendingEnabled});
   return service.status(token,id);
  }
 };
}
