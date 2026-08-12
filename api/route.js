export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { path, payload } = body;

    if (path !== "/route" || !payload?.branch || !payload?.loc) {
      return res.status(400).json({ error: "BAD_REQUEST" });
    }

    const branch = {
      lat: Number(payload.branch.lat),
      lng: Number(payload.branch.lng)
    };
    const loc = {
      lat: Number(payload.loc.lat),
      lng: Number(payload.loc.lng)
    };

    if (![branch.lat,branch.lng,loc.lat,loc.lng].every(Number.isFinite)) {
      return res.status(400).json({ error: "BAD_COORDINATES" });
    }

    const shapeWanted = !!payload.withShape;
    const clientId = "abdeen-delivery";

    // 1) Valhalla motorcycle
    const valhallaHosts = [
      "https://valhalla1.openstreetmap.de",
      "https://valhalla.openstreetmap.de"
    ];

    const valhallaPayload = {
      locations: [
        {lat: branch.lat, lon: branch.lng, radius: 1000},
        {lat: loc.lat, lon: loc.lng, radius: 1000}
      ],
      costing: "motorcycle",
      units: "kilometers",
      shape_format: shapeWanted ? "polyline6" : "no_shape",
      directions_options: {units:"kilometers", language:"ar"}
    };

    let valhallaLast = "VALHALLA_UNAVAILABLE";

    for (const host of valhallaHosts) {
      try {
        const r = await fetch(`${host}/route`, {
          method:"POST",
          headers:{
            "Content-Type":"application/json",
            "Accept":"application/json",
            "X-Client-Id":clientId
          },
          body:JSON.stringify(valhallaPayload)
        });

        const text = await r.text();
        let data = {};
        try { data = JSON.parse(text); } catch {}

        const summary = data?.trip?.summary;
        if (r.ok && !data?.error && summary && Number.isFinite(Number(summary.length))) {
          let shape = [];
          if (shapeWanted && data?.trip?.legs?.[0]?.shape) {
            shape = decodePolyline(data.trip.legs[0].shape, 6);
          }

          return res.status(200).json({
            road:Number(summary.length),
            duration:Number.isFinite(Number(summary.time)) ? Number(summary.time)/60 : null,
            shape,
            routerName:"Valhalla Motorcycle",
            fallbackRouter:false
          });
        }

        valhallaLast = data?.error || text.slice(0,160) || `HTTP_${r.status}`;
      } catch (e) {
        valhallaLast = e?.message || "VALHALLA_ERROR";
      }
    }

    // 2) OSRM fallback. This is road routing, not straight-line distance.
    const coords = `${branch.lng},${branch.lat};${loc.lng},${loc.lat}`;
    const osrmHosts = [
      "https://router.project-osrm.org",
      "https://routing.openstreetmap.de/routed-car"
    ];

    let osrmLast = "OSRM_UNAVAILABLE";

    for (const host of osrmHosts) {
      try {
        const url =
          `${host}/route/v1/driving/${coords}` +
          `?overview=${shapeWanted ? "full" : "false"}` +
          `&geometries=geojson&steps=false`;

        const r = await fetch(url, {
          method:"GET",
          headers:{"Accept":"application/json"}
        });

        const text = await r.text();
        let data = {};
        try { data = JSON.parse(text); } catch {}

        const route = data?.routes?.[0];
        if (r.ok && data?.code === "Ok" && route) {
          const shape = shapeWanted && route.geometry?.coordinates
            ? route.geometry.coordinates.map(p => [p[1],p[0]])
            : [];

          return res.status(200).json({
            road:Number(route.distance || 0)/1000,
            duration:Number(route.duration || 0)/60,
            shape,
            routerName:"OSRM",
            fallbackRouter:true
          });
        }

        osrmLast = data?.message || text.slice(0,160) || `HTTP_${r.status}`;
      } catch (e) {
        osrmLast = e?.message || "OSRM_ERROR";
      }
    }

    return res.status(502).json({
      error:"ROUTING_UNAVAILABLE",
      detail:`Valhalla: ${valhallaLast}; OSRM: ${osrmLast}`
    });

  } catch (e) {
    return res.status(500).json({
      error:"SERVER_ERROR",
      detail:e?.message || "Unknown server error"
    });
  }
}

function decodePolyline(str, precision=6){
  let index=0,lat=0,lng=0,coordinates=[];
  const factor=Math.pow(10,precision);

  while(index<str.length){
    let shift=0,result=0,byte;
    do{
      byte=str.charCodeAt(index++)-63;
      result|=(byte&31)<<shift;
      shift+=5;
    }while(byte>=32);

    const dlat=(result&1)?~(result>>1):(result>>1);

    shift=0;result=0;
    do{
      byte=str.charCodeAt(index++)-63;
      result|=(byte&31)<<shift;
      shift+=5;
    }while(byte>=32);

    const dlng=(result&1)?~(result>>1):(result>>1);
    lat+=dlat;
    lng+=dlng;
    coordinates.push([lat/factor,lng/factor]);
  }

  return coordinates;
}
