// ═══════════════════════════════════════════════════════════════
//  MONTA ROTAÍ — API Serverless
//  Roteirização Inteligente (Cluster + Nearest)
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js')

const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_KEY


// ─────────────────────────────────────────
// DISTÂNCIA
// ─────────────────────────────────────────

function distKm(lat1, lng1, lat2, lng2){

const R = 6371

const dLat = (lat2-lat1)*Math.PI/180
const dLng = (lng2-lng1)*Math.PI/180

const a =
Math.sin(dLat/2)**2 +
Math.cos(lat1*Math.PI/180)*
Math.cos(lat2*Math.PI/180)*
Math.sin(dLng/2)**2

return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))

}


function angleDeg(lat1,lng1,lat2,lng2){

return Math.atan2(
lng2-lng1,
lat2-lat1
)*180/Math.PI

}


// ─────────────────────────────────────────
// NORMALIZAR ENDEREÇO
// ─────────────────────────────────────────

function chaveEnd(end){

if(!end || !end.trim()) return '_sem_'+Math.random()

let s = end.toLowerCase()
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

if(!endereco) return null

try{

const q = encodeURIComponent(
endereco+', Ribeirao Preto, SP, Brasil'
)

const r = await fetch(
`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`,
{
headers:{
'User-Agent':'MontaRotai'
}
}
)

const d = await r.json()

if(d && d[0]){

return{
lat:parseFloat(d[0].lat),
lng:parseFloat(d[0].lon)
}

}

}catch(e){}

return null

}



// ─────────────────────────────────────────
// ALGORITMO INTELIGENTE
// CLUSTER + NEAREST
// ─────────────────────────────────────────

async function otimizarRota({
pedidos,
entregadores,
lojaLat,
lojaLng
}){

const baseLat = lojaLat
const baseLng = lojaLng

const db = createClient(SB_URL,SB_KEY)


// 1️⃣ AGRUPAR POR ENDEREÇO

const mapa = {}

pedidos.forEach(p=>{

const k = chaveEnd(p.endereco_entrega)

if(!mapa[k]) mapa[k]=[]

mapa[k].push(p)

})

const gruposEnd = Object.values(mapa)


// 2️⃣ GEOLOCALIZAR

const paradas=[]

for(const grupo of gruposEnd){

const rep = grupo[0]

let lat = parseFloat(rep.lat_entrega||0)
let lng = parseFloat(rep.lng_entrega||0)

if(!lat || !lng){

const g = await geocode(rep.endereco_entrega)

if(g){

lat=g.lat
lng=g.lng

for(const p of grupo){

await db
.from('entregas')
.update({
lat_entrega:lat,
lng_entrega:lng
})
.eq('id',p.id)

}

}

}

const ang =
(angleDeg(baseLat,baseLng,lat,lng)+360)%360

const dist =
distKm(baseLat,baseLng,lat,lng)

paradas.push({

lat,
lng,
ang,
dist,
end:rep.endereco_entrega,
ids:grupo.map(p=>p.id),
labels:grupo.map(p=>p.numero_pedido||p.cliente_nome)

})

}



// 3️⃣ CLUSTER POR DIREÇÃO

paradas.sort((a,b)=>a.ang-b.ang)

const clusters=[]

const tamanhoCluster =
Math.ceil(paradas.length/entregadores.length)

for(let i=0;i<paradas.length;i+=tamanhoCluster){

clusters.push(
paradas.slice(i,i+tamanhoCluster)
)

}



// 4️⃣ NEAREST NEIGHBOR DENTRO DO CLUSTER

clusters.forEach(cluster=>{

let latAtual=baseLat
let lngAtual=baseLng

const ordenadas=[]
const restantes=[...cluster]

while(restantes.length){

let melhor=0
let melhorDist=999999

restantes.forEach((p,i)=>{

const d = distKm(
latAtual,
lngAtual,
p.lat,
p.lng
)

if(d<melhorDist){

melhorDist=d
melhor=i

}

})

const proxima =
restantes.splice(melhor,1)[0]

ordenadas.push(proxima)

latAtual=proxima.lat
lngAtual=proxima.lng

}

cluster.splice(0,cluster.length,...ordenadas)

})



// 5️⃣ DISTRIBUIR ENTRE ENTREGADORES

const resultado=[]

clusters.forEach((cluster,i)=>{

if(!entregadores[i]) return

resultado.push({

entId:entregadores[i].id,
entNome:entregadores[i].nome,
paradas:cluster

})

})



return{

grupos:resultado,
totalPedidos:pedidos.length,
totalParadas:paradas.length

}

}



// ─────────────────────────────────────────
// API HANDLER
// ─────────────────────────────────────────

module.exports = async function handler(req,res){

const origin = req.headers.origin||''

const allowedOrigins=[

'https://monta-a-rota-ai-frontend.vercel.app',
'https://montarotai.vercel.app',
'http://localhost:3000'

]

if(allowedOrigins.includes(origin)){

res.setHeader(
'Access-Control-Allow-Origin',
origin
)

}

res.setHeader(
'Access-Control-Allow-Methods',
'POST,OPTIONS'
)

res.setHeader(
'Access-Control-Allow-Headers',
'Content-Type,Authorization'
)

if(req.method==='OPTIONS')
return res.status(200).end()

if(req.method!=='POST')
return res.status(405).json({
error:'Metodo nao permitido'
})


try{

const{
lojaId,
distribuicao
}=req.body

const db =
createClient(SB_URL,SB_KEY)


const {data:user} =
await db
.from('usuarios')
.select('loja_lat,loja_lng')
.eq('id',lojaId)
.single()


const {data:pedidos} =
await db
.from('entregas')
.select('*')
.eq('loja_id',lojaId)
.eq('status','pendente')


const entregadores =
(distribuicao||[])
.map(([id,v])=>({

id,
nome:v.nome

}))


const resultado =
await otimizarRota({

pedidos,
entregadores,
lojaLat:user.loja_lat,
lojaLng:user.loja_lng

})


return res
.status(200)
.json(resultado)


}catch(err){

console.error(err)

return res
.status(500)
.json({error:'erro interno'})

}

}
