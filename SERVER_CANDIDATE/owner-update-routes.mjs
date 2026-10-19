export function mountOwnerUpdateRoutes({app,service}){
 const token=req=>{const h=req.headers?.authorization;if(typeof h!=='string'||!/^Bearer [^\s]+$/.test(h))throw Error('OWNER_REQUIRED');return h.slice(7);};
 const wrap=run=>async(req,res)=>{try{res.json(await run(req));}catch(e){res.status(e.message==='OWNER_REQUIRED'?403:409).json({error:e.message==='OWNER_REQUIRED'?'OWNER_REQUIRED':'OWNER_UPDATE_UNCONFIRMED',outcome:'UNCONFIRMED',retryAllowed:false});}};
 app.post('/jack-owner-update',wrap(req=>service.send(token(req),req.body)));
 app.get('/jack-owner-update-status/:id',wrap(req=>service.status(token(req),req.params.id)));
}
