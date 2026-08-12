export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { path, payload } = body;

    if (!path || !payload) {
      return res.status(400).json({ error: "BAD_REQUEST" });
    }

    const VALHALLA = [
      "https://valhalla1.openstreetmap.de",
      "https://valhalla.openstreetmap.de"
    ];

    const OSRM = [
      "https://routing.openstreetmap.de/routed-car",
      "https://router.project-osrm.org"
    ];

    const clientId = "abdeen-delivery.vercel.app";

    async function valhalla(action, data) {
      let last = "VALHALLA_UNAVAILABLE";

      for (const host of VALHALLA) {
        // POST first
        try {
          const r = await fetch(`${host}${action}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "X-Client-Id": clientId
            },
            body: JSON.stringify(data)
          });

          const text = await r.text();
          let json = {};
          try { json = JSON.parse(text); } catch {}

          if (r.ok && !json?.error) return json;
          last = json?.error || text?.slice(0, 180) || `HTTP_${r.status}`;
        } catch (e) {
          last = e?.message || "VALHALLA_POST_ERROR";
        }

        // GET fallback
        try {
          const url = `${host}${action}?json=${encodeURIComponent(JSON.stringify(data))}`;
          const r = await fetch(url, {
            method: "GET",
            headers: {
              "Accept": "application/json",
              "X-Client-Id": clientId
            }
          });

          const text = await r.text();
          let json = {};
          try { json = JSON.parse(text); } catch {}

          if (r.ok && !json?.error) return json;
          last = json?.error || text?.slice(0, 180) || `HTTP_${r.status}`;
        } catch (e) {
          last = e?.message || "VALHALLA_GET_ERROR";
        }
      }

      throw new Error(last);
    }

    async function osrm(branch, loc, withShape) {
      const coords = `${branch.lng},${branch.lat};${loc.lng},${loc.lat}`;
      let last = "OSRM_UNAVAILABLE";

      for (const server of OSRM) {
        try {
          const url =
            `${server}/route/v1/driving/${coords}` +
            `?overview=${withShape ? "full" : "false"}` +
            `&geometries=geojson&steps=false`;

          const r = await fetch(url, {
            method: "GET",
            headers: { "Accept": "application/json" }
          });

          const text = await r.text();
          let data = {};
          try { data = JSON.parse(text); } catch {}

          if (!r.ok || data?.code !== "Ok" || !data?.routes?.[0]) {
            last = data?.message || text?.slice(0, 180) || `HTTP_${r.status}`;
            continue;
          }

          const route = data.routes[0];

          return {
            ...branch,
            road: (route.distance || 0) / 1000,
            duration: (route.duration || 0) / 60,
            shape: withShape && route.geometry?.coordinates
              ? route.geometry.coordinates.map(p => [p[1], p[0]])
              : [],
            fallbackRouter: true,
            routerName: "OSRM"
          };
        } catch (e) {
          last = e?.message || "OSRM_ERROR";
        }
      }

      throw new Error(last);
    }

    // Individual route: Valhalla motorcycle first, OSRM fallback.
    if (path === "/route") {
      try {
        const data = await valhalla("/route", payload);
        if (!data?.trip?.summary || data.trip.summary.length == null) {
          throw new Error("VALHALLA_NO_ROUTE");
        }
        return res.status(200).json(data);
      } catch (e) {
        const locations = payload?.locations || [];
        if (locations.length < 2) {
          return res.status(400).json({ error: "BAD_ROUTE_LOCATIONS" });
        }

        const branch = {
          lat: Number(locations[0].lat),
          lng: Number(locations[0].lon)
        };
        const loc = {
          lat: Number(locations[1].lat),
          lng: Number(locations[1].lon)
        };

        try {
          const fallback = await osrm(branch, loc, payload?.shape_format !== "no_shape");
          return res.status(200).json({
            trip: {
              summary: {
                length: fallback.road,
                time: (fallback.duration || 0) * 60
              },
              legs: [{
                shape: ""
              }]
            },
            _fallback: fallback
          });
        } catch (fallbackError) {
          return res.status(502).json({
            error: "ROUTING_UNAVAILABLE",
            detail: String(fallbackError?.message || e?.message || "NO_ROUTER")
          });
        }
      }
    }

    // Matrix: Valhalla first. If unavailable, calculate each branch through OSRM.
    if (path === "/sources_to_targets") {
      try {
        return res.status(200).json(await valhalla("/sources_to_targets", payload));
      } catch (e) {
        const sources = payload?.sources || [];
        const targets = payload?.targets || [];
        if (!sources.length || !targets.length) {
          return res.status(400).json({ error: "BAD_MATRIX_LOCATIONS" });
        }

        const rows = [];
        for (const source of sources) {
          const branch = { lat: Number(source.lat), lng: Number(source.lon) };
          const loc = { lat: Number(targets[0].lat), lng: Number(targets[0].lon) };

          try {
            const r = await osrm(branch, loc, false);
            rows.push({
              from_index: rows.length,
              to_index: 0,
              distance: r.road,
              time: (r.duration || 0) / 60
            });
          } catch {
            rows.push({
              from_index: rows.length,
              to_index: 0,
              distance: null,
              time: null
            });
          }
        }

        if (!rows.some(x => x.distance != null)) {
          return res.status(502).json({
            error: "ROUTING_UNAVAILABLE",
            detail: "Valhalla and OSRM are unavailable"
          });
        }

        return res.status(200).json({
          sources: sources.map((_, i) => ({ original_index: i })),
          targets: targets.map((_, i) => ({ original_index: i })),
          sources_to_targets: rows
        });
      }
    }

    return res.status(400).json({ error: "UNSUPPORTED_ACTION" });

  } catch (e) {
    return res.status(500).json({
      error: "SERVER_ERROR",
      detail: e?.message || "Unknown server error"
    });
  }
}

