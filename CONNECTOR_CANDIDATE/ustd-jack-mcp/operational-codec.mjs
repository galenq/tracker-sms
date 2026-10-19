// Staged local contract only. No database, browser storage, authentication or network writes.
const collections=['trucks','facilityHistory','carrierProfiles','financialRecords','revenueLoads','weeklyStatements'];
const mainKeys=new Set([...collections,'selectedTruckId','lastBackupAt','nextUstdInvoiceNumber','ustdRemovedBillingKeys','ustdProductionCleanStartCompleted','payments','moneyPayments','paymentRecords']);
const forbidden=/(bank|routing|account.?number|card.?number|cvv|cvc|password|credential|access.?token|refresh.?token|secret|api.?key)/i;
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const jsonCopy=o=>JSON.parse(JSON.stringify(o));
function inspect(v,depth=0){
 if(depth>40)throw Error('Snapshot nesting too deep');
 if(v===null||typeof v==='string'||typeof v==='boolean')return;
 if(typeof v==='number'&&Number.isFinite(v))return;
 if(Array.isArray(v)){for(const x of v)inspect(x,depth+1);return;}
 if(v&&Object.getPrototypeOf(v)===Object.prototype){for(const [k,x] of Object.entries(v)){if(forbidden.test(k)||['__proto__','prototype','constructor'].includes(k))throw Error('Sensitive or unsafe key: snapshot retained locally; review required');inspect(x,depth+1);}return;}
 throw Error('Plain JSON required');
}
function ids(name,rows){
 if(!Array.isArray(rows)||rows.length>10000)throw Error('Invalid collection '+name);
 const seen=new Set();for(const row of rows){const id=row?.[name==='facilityHistory'?'key':'id'];if(typeof id!=='string'||!id.length||id.length>512||/[\u0000-\u001f]/.test(id)||seen.has(id))throw Error('Invalid or duplicate record identity');seen.add(id);}return seen;
}
export function validate(snapshot){
 inspect(snapshot);
 if(snapshot.schemaVersion!==3||snapshot.kind!=='USTD_OPERATIONAL_FULL_STATE'||snapshot.environment!=='PRODUCTION')throw Error('Staged operational contract required');
 if(Object.keys(snapshot).sort().join(',')!=='capturedAt,environment,expenses,kind,main,receipts,schemaVersion'||!Number.isFinite(Date.parse(snapshot.capturedAt)))throw Error('Invalid snapshot boundary');
 const main=snapshot.main;if(!main||Array.isArray(main))throw Error('Main state required');
 for(const key of Object.keys(main))if(!mainKeys.has(key))throw Error('Unclassified main state; review required');
 for(const key of ['payments','moneyPayments','paymentRecords'])if(own(main,key)&&(!Array.isArray(main[key])||main[key].length>10000))throw Error('Invalid legacy payment collection');
 // Preserve optional legacy roots exactly. Do not invent or remove finance defaults.
 const sets={};for(const name of collections)if(own(main,name))sets[name]=ids(name,main[name]);
 if(!sets.trucks)throw Error('Truck collection required');
 if(own(main,'selectedTruckId')&&main.selectedTruckId!==null&&!sets.trucks.has(main.selectedTruckId))throw Error('Dangling selected truck');
 // Old billing/history references may survive legitimate record removal. Preserve them;
 // mutation authorization must compare the candidate to its complete baseline.
 ids('expenses',snapshot.expenses);const receiptIds=ids('receipts',snapshot.receipts);
 for(const expense of snapshot.expenses)if(expense.receiptId&&!receiptIds.has(expense.receiptId))throw Error('Receipt missing: complete backup required');
 for(const receipt of snapshot.receipts){
  if(typeof receipt.bytesBase64!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(receipt.bytesBase64)||!Number.isSafeInteger(receipt.sizeBytes)||receipt.sizeBytes<0||typeof receipt.name!=='string'||typeof receipt.type!=='string'||!/^[0-9a-f]{64}$/.test(receipt.sha256))throw Error('Invalid receipt metadata');
 }
 if(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength>2000000)throw Error('Snapshot exceeds tested byte limit; retain locally');
 return jsonCopy(snapshot);
}
async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function prepare(snapshot){
 const copy=validate(snapshot);
 for(const receipt of copy.receipts){const bytes=Uint8Array.from(atob(receipt.bytesBase64),c=>c.charCodeAt(0));if(bytes.length!==receipt.sizeBytes||await digest(bytes)!==receipt.sha256)throw Error('Receipt bytes or checksum mismatch');}
 const payload=JSON.stringify(copy);return {payload,checksum:await digest(new TextEncoder().encode(payload))};
}
