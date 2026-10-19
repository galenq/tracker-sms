// Exact receipt mapping for deployed tracker-sms commit a0799b7.
// No transport, credentials, network access, or automatic retry lives here.
export function legacySMSReceipt(httpStatus, body) {
 if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300 ||
     !body || typeof body !== 'object' || Array.isArray(body) ||
     body.success !== true || typeof body.sid !== 'string' || !/^SM[a-fA-F0-9]{32}$/.test(body.sid)) {
  return {accepted:false, uncertain:true, retryAllowed:false};
 }
 return {accepted:true, messageId:body.sid, deliveryConfirmed:false, retryAllowed:false};
}
