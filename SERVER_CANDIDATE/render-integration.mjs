import {createApprovedMessageService} from './message-service.mjs';
import {createSupabaseMessageStore} from './supabase-store.mjs';
import {createTwilioMessageSender,createTwilioStatusHandler} from './twilio-receipts.mjs';
import {mountApprovedMessageRoutes} from './http-routes.mjs';
import {prepare} from '../CONNECTOR_CANDIDATE/ustd-jack-mcp/operational-codec.mjs';
import {createOwnerUpdateService} from './owner-update-service.mjs';
import {mountOwnerUpdateRoutes} from './owner-update-routes.mjs';
const OWNER='f3208b50-b621-444e-a048-76c889a38acc',PROJECT='https://ajayrismmiwgybtezisf.supabase.co';
const PUBLISHABLE_KEY='sb_publishable_GaQyB2O9sLQU0ejMyBO6Cg_VPukAWwv';
const endpoint=PROJECT+'/functions/v1/tracker-live-secure-bridge?scope=protected-full-state-v1';
export async function mountExistingTrackerServer({app,client,supabase,twilio,createClient,env,recordOutbound,fetchImpl=fetch}){
 if(env.USTD_JACK_MESSAGES_ENABLED!=='true')return {enabled:false};
 if(!env.TWILIO_SID||!env.TWILIO_AUTH||!env.TWILIO_NUMBER||!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw Error('SERVER_MESSAGE_CONFIG_REQUIRED');
 // Auth verifies the Jack Bridge owner; existing supabase continues using the SMS database.
 const authClient=createClient(PROJECT,PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const verifyUser=async token=>{const r=await authClient.auth.getUser(token);return r.error?null:r.data?.user;};
 async function readCanonical(token){
  const headers={authorization:'Bearer '+token,'content-type':'application/json',origin:'https://tracker.ustruckdispatch.com'};
  const capability=await fetchImpl(endpoint,{method:'GET',headers}),cap=await capability.json();
  if(!capability.ok||cap.protocol!=='USTD_FULL_STATE_CAS_V1'||cap.environment!=='PRODUCTION'||cap.owner_user_id!==OWNER||cap.ready!==true)throw Error('VERIFIED_CANONICAL_READ_REQUIRED');
  const response=await fetchImpl(endpoint,{method:'POST',headers,body:JSON.stringify({operation:'READ_FULL',protocol:'USTD_FULL_STATE_CAS_V1',verify_field_command:{protocol:'USTD_FULL_STATE_CAS_V1'}})}),row=await response.json();
  if(!response.ok||row.verified!==true||row.environment!=='PRODUCTION'||!Number.isSafeInteger(row.revision)||row.revision<0)throw Error('VERIFIED_CANONICAL_READ_REQUIRED');
  const snapshot=JSON.parse(row.payload_text),packed=await prepare(snapshot);if(packed.payload!==row.payload_text||packed.checksum!==row.checksum)throw Error('VERIFIED_CANONICAL_READ_REQUIRED');
  return {snapshot,revision:row.revision,checksum:row.checksum};
 }
 const store=createSupabaseMessageStore(supabase),providerSend=createTwilioMessageSender({client,from:env.TWILIO_NUMBER});
 const sendOnce=async(body,approval)=>{const result=await providerSend(body,approval);try{if(result.body?.success===true)await recordOutbound?.({to:body.to,body:body.message,messageSid:result.body.sid,receivedAt:new Date().toISOString()});}catch(_){/* Provider acceptance remains true; the protected journal retains the SID. */}return result;};
 const service=createApprovedMessageService({verifyUser,readCanonical,store,sendOnce,isSendingEnabled:()=>env.USTD_JACK_MESSAGE_SEND_ENABLED==='true'});
 const statusHandler=createTwilioStatusHandler({validateRequest:twilio.validateRequest,authToken:env.TWILIO_AUTH,accountSid:env.TWILIO_SID,from:env.TWILIO_NUMBER,store});
 mountApprovedMessageRoutes({app,service,statusHandler});
 if(env.USTD_JACK_OWNER_PHONE||env.USTD_JACK_OWNER_UPDATES_ENABLED==='true'){
  const ownerUpdates=createOwnerUpdateService({verifyUser,readCanonical,store,sendOnce,ownerRecipient:env.USTD_JACK_OWNER_PHONE,isSendingEnabled:()=>env.USTD_JACK_MESSAGE_SEND_ENABLED==='true'&&env.USTD_JACK_OWNER_UPDATES_ENABLED==='true'});
  mountOwnerUpdateRoutes({app,service:ownerUpdates});
 }
 return {enabled:true};
}
