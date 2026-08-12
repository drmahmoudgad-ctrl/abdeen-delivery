export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({error:"METHOD_NOT_ALLOWED"});

  try {
    const body=typeof req.body==="string"?JSON.parse(req.body):(req.body||{});
    const {path,payload}=body;
    if(!path||!payload) return res.status(400).json({error:"BAD_REQUEST"});

    const valhallaHosts=[
      "https://valhalla1.openstreetmap.de",
      "https://valhalla.openstreetmap.de"
    ];
    const osrmHosts=[
      "https://routing.openstreetmap.de/routed-car",
      "https://router.project-osrm.org"
    ];

    async function osrmRoute(branch,loc,withShape=false){
      const coords=`${branch.lng},${branch.lat};${loc.lng},${loc.lat}`;
      let last="OSRM_UNAVAILABLE";
      for(const host of osrmHosts){
        try{
          const u=`${host}/route/v1/driving/${coords}?overview=${withShape?"full":"false"}&geometries=geojson&steps=false`;
          const r=await fetch(u,{headers:{Accept:"application/json"}});
          const t=await r.text();
          let d={}; try{d=JSON.parse(t)}catch{}
          if(!r.ok||d?.code!=="Ok"||!d?.routes?.[0]){
            last=d?.message||`HTTP_${r.status}`; continue;
          }
          const rt=d.routes[0];
          return {
            ...branch,
            road:(rt.distance||0)/1000,
            duration:(rt.duration||0)/60,
            shape:withShape&&rt.geometry?.coordinates?rt.geometry.coordinates.map(p=>[p[1],p[0]]):[],
            fallbackRouter:true,
            routerName:"OSRM"
          };
        }catch(e){last=e?.message||"OSRM_ERROR"}
      }
      throw new Error(last);
    }

    async function valhallaRoute(data){
      let last="VALHALLA_UNAVAILABLE";
      for(const host of valhallaHosts){
        try{
          const r=await fetch(`${host}/route`,{
            method:"POST",
            headers:{
              "Content-Type":"application/json",
              "Accept":"application/json",
              "X-Client-Id":"abdeen-delivery"
            },
            body:JSON.stringify(data)
          });
          const t=await r.text();
          let d={}; try{d=JSON.parse(t)}catch{}
          if(r.ok&&!d?.error) return d;
          last=d?.error||t.slice(0,180)||`HTTP_${r.status}`;
        }catch(e){last=e?.message||"VALHALLA_ERROR"}
      }
      throw new Error(last);
    }

    if(path==="/route"){
      try{
        return res.status(200).json(await valhallaRoute(payload));
      }catch(e){
        const ls=payload?.locations||[];
        if(ls.length<2) return res.status(400).json({error:"BAD_ROUTE_LOCATIONS"});
        const branch={lat:Number(ls[0].lat),lng:Number(ls[0].lon)};
        const loc={lat:Number(ls[1].lat),lng:Number(ls[1].lon)};
        try{
          const fb=await osrmRoute(branch,loc,payload.shape_format!=="no_shape");
          return res.status(200).json({_fallback:fb});
        }catch(f){
          return res.status(502).json({error:"ROUTING_UNAVAILABLE",detail:String(f?.message||e?.message||"NO_ROUTER")});
        }
      }
    }

    if(path==="/osrm"){
      const {branch,loc,withShape}=payload;
      if(!branch||!loc) return res.status(400).json({error:"BAD_OSRM_PAYLOAD"});
      try{return res.status(200).json(await osrmRoute(branch,loc,!!withShape))}
      catch(e){return res.status(502).json({error:"OSRM_UNAVAILABLE",detail:String(e?.message||"NO_ROUTER")})}
    }

    if(path==="/sources_to_targets"){
      // Try Valhalla matrix. If it fails, calculate every branch with OSRM so
      // the "all branches" feature remains functional.
      try{
        let last="VALHALLA_UNAVAILABLE";
        for(const host of valhallaHosts){
          try{
            const r=await fetch(`${host}/sources_to_targets`,{
              method:"POST",
              headers:{
                "Content-Type":"application/json",
                "Accept":"application/json",
                "X-Client-Id":"abdeen-delivery"
              },
              body:JSON.stringify(payload)
            });
            const t=await r.text(); let d={}; try{d=JSON.parse(t)}catch{}
            if(r.ok&&!d?.error) return res.status(200).json(d);
            last=d?.error||`HTTP_${r.status}`;
          }catch(e){last=e?.message||"VALHALLA_ERROR"}
        }
        throw new Error(last);
      }catch(e){
        const sources=payload?.sources||[], target=payload?.targets?.[0];
        if(!sources.length||!target) return res.status(400).json({error:"BAD_MATRIX_LOCATIONS"});
        const rows=[];
        for(let i=0;i<sources.length;i++){
          const b={lat:Number(sources[i].lat),lng:Number(sources[i].lon)};
          const l={lat:Number(target.lat),lng:Number(target.lon)};
          try{
            const r=await osrmRoute(b,l,false);
            rows.push({from_index:i,to_index:0,distance:r.road,time:r.duration*60,routerName:"OSRM"});
          }catch{
            rows.push({from_index:i,to_index:0,distance:null,time:null,routerName:"OSRM"});
          }
        }
        if(!rows.some(x=>x.distance!=null))
          return res.status(502).json({error:"ROUTING_UNAVAILABLE"});
        return res.status(200).json({sources_to_targets:rows});
      }
    }

    return res.status(400).json({error:"UNSUPPORTED_ACTION"});
  }catch(e){
    return res.status(500).json({error:"SERVER_ERROR",detail:String(e?.message||"Unknown error")});
  }
}
