import {fingerprint,phone,proposeMessage,proposeLocation,createMessageReview} from './communications.mjs';
// Both server and browser derive the same typed binding; raw profile and financial fields never leave this function.
export async function bindingFromTracker({snapshot,revision,checksum},truckId){
 if(!snapshot?.main||!Number.isSafeInteger(revision)||!/^[a-f0-9]{64}$/.test(checksum??''))throw Error('VERIFIED_CANONICAL_READ_REQUIRED');
 const truck=snapshot.main.trucks?.find(t=>t.id===truckId&&t.archive!==true);if(!truck)throw Error('ACTIVE_TRUCK_REQUIRED');
 const recipient=phone(truck.driverPhone);
 return {truckId:truck.id,driverId:await fingerprint([truck.driverName??'',recipient]),recipient,loadReference:await fingerprint([truck.loadNumber??'',truck.pickup??'',truck.delivery??'',truck.broker??'']),revision,checksum};
}
// Call only from createJackService.propose AFTER its existing authenticated canonical() check.
export async function trackerCommunicationProposal(current,input){
 if(!input||!['SEND_SMS','REQUEST_LOCATION'].includes(input.command_type))throw Error('MESSAGE_ACTION_NOT_SUPPORTED');
 const binding=await bindingFromTracker(current,input.truck_id);let proposal;
 if(input.command_type==='SEND_SMS'){
  if(!input.payload||Object.keys(input.payload).join(',')!=='message')throw Error('MESSAGE_ACTION_NOT_SUPPORTED');
  proposal=await proposeMessage(binding,{kind:'SEND_SMS',body:input.payload.message});
 }else{if(!input.payload||Object.keys(input.payload).length)throw Error('MESSAGE_ACTION_NOT_SUPPORTED');proposal=proposeLocation(binding);}
 return {proposed:true,queued:false,applied:false,sent:false,owner_approval_required:true,review:proposal,review_url:'https://tracker.ustruckdispatch.com/#jack-message-review='+encodeURIComponent(JSON.stringify(proposal)),message:'Review the exact recipient and message in Tracker. Nothing has been sent.'};
}
export function createTrackerMessageAdapter({runtime,journal,sendApproved,verifyOwner}){
 if(!runtime?.started||!runtime.bridge)throw Error('TRACKER_NOT_READY');
 if(typeof verifyOwner!=='function'||typeof runtime.bridge.transport?.readFull!=='function')throw Error('AUTHENTICATED_TRACKER_READ_REQUIRED');
 const bridge=runtime.bridge;let truckId=null;
 const controller=createMessageReview({journal,sendApproved,readBinding:async()=>{
  await verifyOwner();await bridge.localReady();if(bridge.blocked||bridge.writeInFlight||!await bridge.coordinator.isClean())throw Error('SAVE_OR_RECOVER_LOCAL_DRAFT_FIRST');
  const baseline=await bridge.coordinator.baseline(),generation=await bridge.coordinator.generation();
  const remote=await bridge.transport.readFull();await bridge.localReady();
  if(remote.revision!==baseline.revision||remote.checksum!==baseline.checksum)throw Error('SHARED_TRACKER_CHANGED');
  if(generation!==await bridge.coordinator.generation()||bridge.blocked||bridge.writeInFlight||!await bridge.coordinator.isClean())throw Error('SAVE_OR_RECOVER_LOCAL_DRAFT_FIRST');
  if(bridge.snapshot.main.selectedTruckId!==truckId)throw Error('SELECT_PROPOSED_TRUCK_FIRST');
  return bindingFromTracker({snapshot:bridge.snapshot,revision:baseline.revision,checksum:baseline.checksum},truckId);
 }});
 return {async review(p){truckId=p?.binding?.truckId;return controller.review(p);},approve:v=>controller.approve(v),discard:()=>controller.discard(),pending:()=>controller.pending()};
}
