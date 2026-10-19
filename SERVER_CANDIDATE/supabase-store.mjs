// Reuses the existing server-side Supabase client. Never pass a browser/publishable client.
// Candidate PostgREST adapter; managed Supabase verification remains required.
export function createSupabaseMessageStore(client){
 const result=async p=>{const {data,error}=await p;if(error)throw Error('MESSAGE_JOURNAL_UNAVAILABLE');return data;};
 const update=async q=>{const r=await result(q.select('id').maybeSingle());if(!r)throw Error('MESSAGE_STATE_CHANGED');return r;};
 const table=()=>client.from('ustd_jack_message_actions');
 return {
  create:r=>result(table().insert(r).select('*').single()),
  read:(owner,id)=>result(table().select('*').eq('owner_id',owner).eq('id',id).maybeSingle()),
  reserve:(owner,id,hash)=>result(client.rpc('ustd_jack_sms_reserve',{p_owner:owner,p_id:id,p_hash:hash})),
  cancelBeforeSend:(owner,id)=>update(table().update({state:'CANCELLED'}).eq('owner_id',owner).eq('id',id).eq('state','RESERVED')),
  rejectOptOut:(owner,id)=>update(table().update({state:'REJECTED',failure_code:'RECIPIENT_OPTED_OUT'}).eq('owner_id',owner).eq('id',id).eq('state','RESERVED')),
  unknown:(owner,id)=>update(table().update({state:'UNKNOWN'}).eq('owner_id',owner).eq('id',id).eq('state','RESERVED')),
  async accept(owner,id,sid){const row=await result(table().select('state,message_id').eq('owner_id',owner).eq('id',id).maybeSingle());if(row?.state==='ACCEPTED'&&row.message_id===sid)return {id};return update(table().update({state:'ACCEPTED',message_id:sid}).eq('owner_id',owner).eq('id',id).in('state',['RESERVED','UNKNOWN']));},
  callback:(owner,id,hash,sid,status)=>result(client.rpc('ustd_jack_sms_callback',{p_owner:owner,p_id:id,p_hash:hash,p_sid:sid,p_status:status}))
 };
}
