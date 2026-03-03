// ═══════════════════════════════════════════════════════════════
// MONTA ROTAÍ — API Serverless
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js')

const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_KEY

// ─────────────────────────────────────────
// DISTÂNCIA HAVERSINE
// ─────────────────────────────────────────

function distKm(lat1, lng1, lat2, lng2) {

  const R = 6371

  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180

  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1*Math.PI/180) *
    Math.cos(lat2*Math.PI/180) *
    Math.sin(dLng/2) * Math.sin(dLng/2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))

  return R * c
}

// ─────────────────────────────────────────
// NORMALIZA ENDEREÇO
// ─────────────────────────────────────────

function chaveEnd(end) {

  if(!end) return '_'

  let s = end
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s]/g,' ')
    .replace(/\s+/g,' ')
    .trim()

  return s.substring(0,40)
}

// ─────────────────────────────────────────
// GEOCODE
// ─────────────────────────────────────────

async function geocode(endereco){

  try{

    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q="
      + encodeURIComponent(endereco + ", Ribeirao Preto SP Brasil")

    const r = await fetch(url)

    const j = await r.json()

    if(j && j[0]){

      return {
        lat: parseFloat(j[0].lat),
        lng: parseFloat(j[0].lon)
      }

    }

  }catch(e){}

  return null

}

// ─────────────────────────────────────────
// ALGORITMO DE ROTA
// ─────────────────────────────────────────

async function otimizarRota({pedidos, entregadores, lojaLat, lojaLng}){

  const db = createClient(SB_URL, SB_KEY)

  const mapa = {}

  for(const p of pedidos){

    const key = chaveEnd(p.endereco_entrega)

    if(!mapa[key]) mapa[key] = []

    mapa[key].push(p)

  }

  const paradas = []

  for(const grupo of Object.values(mapa)){

    const rep = grupo[0]

    let lat = parseFloat(rep.lat_entrega || 0)
    let lng = parseFloat(rep.lng_entrega || 0)

    if(!lat || !lng){

      const g = await geocode(rep.endereco_entrega)

      if(g){

        lat = g.lat
        lng = g.lng

        for(const p of grupo){

          await db
          .from("entregas")
          .update({
            lat_entrega: lat,
            lng_entrega: lng
          })
          .eq("id", p.id)

        }

      }

    }

    const dist = distKm(lojaLat, lojaLng, lat, lng)

    paradas.push({
      lat,
      lng,
      dist,
      pedidos: grupo
    })

  }

  // ordenar pela distância da loja

  paradas.sort((a,b)=>a.dist-b.dist)

  const grupos = entregadores.map(e=>({
    entId:e.id,
    entNome:e.nome,
    paradas:[]
  }))

  let idx = 0

  for(const p of paradas){

    grupos[idx].paradas.push(p)

    idx++

    if(idx>=grupos.length) idx=0

  }

  // ordenar rota interna

  for(const g of grupos){

    let latAtual = lojaLat
    let lngAtual = lojaLng

    const ordenado = []
    const resto = [...g.paradas]

    while(resto.length){

      let melhor = 0
      let melhorDist = 9999

      resto.forEach((p,i)=>{

        const d = distKm(latAtual,lngAtual,p.lat,p.lng)

        if(d<melhorDist){
          melhorDist=d
          melhor=i
        }

      })

      const next = resto.splice(melhor,1)[0]

      ordenado.push(next)

      latAtual = next.lat
      lngAtual = next.lng

    }

    g.paradas = ordenado

  }

  const resultado = []

  for(const g of grupos){

    const pedidosFlat = []

    for(const parada of g.paradas){

      for(const p of parada.pedidos){

        pedidosFlat.push({
          id:p.id,
          num:p.numero_pedido,
          cliente:p.cliente_nome,
          end:p.endereco_entrega,
          dist:parada.dist
        })

      }

    }

    resultado.push({
      entId:g.entId,
      entNome:g.entNome,
      pedidos:pedidosFlat,
      totalParadas:g.paradas.length,
      totalPedidos:pedidosFlat.length
    })

  }

  return {
    grupos:resultado,
    totalPedidos:pedidos.length
  }

}

// ─────────────────────────────────────────
// API HANDLER
// ─────────────────────────────────────────

module.exports = async function handler(req,res){

  const origin = req.headers.origin || ""

  const allowed = [
    "https://montarotai.vercel.app",
    "https://monta-a-rota-ai-frontend.vercel.app",
    "http://localhost:3000"
  ]

  if(!allowed.includes(origin))
    return res.status(403).json({error:"origem bloqueada"})

  res.setHeader("Access-Control-Allow-Origin",origin)
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS")
  res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization")

  if(req.method==="OPTIONS")
    return res.status(200).end()

  if(req.method!=="POST")
    return res.status(405).json({error:"method"})

  try{

    const {lojaId,distribuicao} = req.body

    const db = createClient(SB_URL,SB_KEY)

    const {data:user} = await db
    .from("usuarios")
    .select("loja_lat,loja_lng")
    .eq("id",lojaId)
    .single()

    const {data:pedidos} = await db
    .from("entregas")
    .select("*")
    .eq("loja_id",lojaId)
    .eq("status","pendente")

    const entregadores =
      (distribuicao||[])
      .map(([id,v])=>({
        id,
        nome:v.nome
      }))

    const resultado = await otimizarRota({
      pedidos,
      entregadores,
      lojaLat:user.loja_lat,
      lojaLng:user.loja_lng
    })

    return res.status(200).json(resultado)

  }catch(err){

    console.error(err)

    return res.status(500).json({error:"server"})

  }

}
