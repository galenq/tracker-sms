// Register additive routes only after supplying authenticated service and verified callback handler.
export function mountApprovedMessageRoutes({app,service,statusHandler}){
 const token=req=>{const h=req.headers?.authorization;if(typeof h!=='string'||!/^Bearer [^\s]+$/.test(h))throw Error('OWNER_REQUIRED');return h.slice(7);};
 const wrap=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){const denied=e.message==='OWNER_REQUIRED';res.status(denied?403:409).json({error:denied?'OWNER_REQUIRED':'MESSAGE_REVIEW_REQUIRED',outcome:'UNCONFIRMED',retryAllowed:false});}};
 app.post('/jack-sms-review',wrap(req=>service.review(token(req),req.body)));
 app.post('/jack-sms-approve',wrap(req=>service.approve(token(req),req.body)));
 app.get('/jack-sms-status/:id',wrap(req=>service.status(token(req),req.params.id)));
 app.post('/jack-sms-status',async(req,res)=>{try{await statusHandler({originalUrl:req.originalUrl,signature:req.headers?.['x-twilio-signature'],body:req.body});res.status(200).end();}catch(_){res.status(403).end();}});
}
