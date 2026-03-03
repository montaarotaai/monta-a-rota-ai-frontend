// ═══════════════════════════════════════════════════════════════
//  MONTA ROTAÍ — API Serverless: /api/calcular-rota
//  © 2025 Monta Rotaí. Sistema Proprietário. Todos os direitos
//  reservados.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;


// ─────────────────────────────────────────────────
// DISTÂNCIA
// ─────────────────────────────────────────────────

function distKm(lat1, lng1, lat2, lng2) {

  const R = 6371;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

}

function angleDeg(lat1, lng1, lat2, lng2) {
  return Math.atan2(lng2 - lng1, lat2 - lat1) * 180 / Math.PI;
}


// ─────────────────────────────────────────────────
// NORMALIZA ENDEREÇO
// ─────────────────────────────────────────────────

function chaveEnd(end) {

  if (!end || !end.trim()) return '_sem_' + Math.random();

  let s = end.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(avenida|avenue|av\.?|rua|r\.?|alameda|al\.?|travessa|tv\.?|estrada|est\.?|praca|pca\.?|rodovia|rod\.?|viela|vila|v\.?)\b/g, ' ')
    .replace(/\b(apto?|apartamento|ap\.?|bloco|bl\.?|torre|t\.?|sala|sl\.?|casa|lote|lt\.?|cond|condominio|kit|subsetor|setor|conjunto|cj\.?)\b.*/,'')
    .replace(/[-,]\s*[a-z\s]{3,}$/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const m = s.match(/([a-z][a-z0-9\s]{2,}?)\s+(\d{2,5})\b/);

  if (m) {

    const palavras = m[1].trim().split(/\s+/);
    const filtradas = palavras.filter(p => p.length > 2);

    return (filtradas.slice(-3).join(' ') + ' ' + m[2]).trim();

  }

  return s.substring(0, 40);

}


// ─────────────────────────────────────────────────
// GEOCODING
// ─────────────────────────────────────────────────

async function geocode(endereco) {

  if (!endereco) return null;

  try {

    const q = encodeURIComponent(endereco + ', Ribeirao Preto, SP, Brasil');

    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`,
      { headers: { 'User-Agent': 'MontaRotai/1.0' } }
    );

    const d = await r.json();

    if (d && d[0]) {

      return {
        lat: parseFloat(d[0].lat),
        lng: parseFloat(d[0].lon)
      };

    }

  } catch (e) {}

  return null;

}


// ─────────────────────────────────────────────────
// VALOR CORRIDA
// ─────────────────────────────────────────────────

function calcularValorCorrida(distancia, taxaTipo, taxaBase, kmLimite, taxaExcedente, taxaFixoBase) {

  if (taxaTipo === 'por_km') {

    if (distancia <= kmLimite) return taxaBase;

    return taxaBase + (distancia - kmLimite) * taxaExcedente;

  }

  if (taxaTipo === 'fixo_mais_km') {

    if (distancia <= kmLimite) return taxaFixoBase + taxaBase;

    return taxaFixoBase + taxaBase + (distancia - kmLimite) * taxaExcedente;

  }

  return taxaBase;

}


// ─────────────────────────────────────────────────
// ALGORITMO DE ROTA
// ─────────────────────────────────────────────────

async function otimizarRota({ pedidos, entregadores, lojaLat, lojaLng, limiteGlobal, taxaConfig }) {

  const RP_LAT = -21.1775;
  const RP_LNG = -47.8103;

  const baseLat = lojaLat || RP_LAT;
  const baseLng = lojaLng || RP_LNG;


  const mapaEnds = {};

  pedidos.forEach(p => {

    const k = chaveEnd(p.endereco_entrega);

    if (!mapaEnds[k]) mapaEnds[k] = [];

    mapaEnds[k].push(p);

  });

  const paradaList = Object.values(mapaEnds);

  const db = createClient(SB_URL, SB_KEY);

  const paradasGeo = [];


  for (const grupo of paradaList) {

    const rep = grupo[0];

    let lat = parseFloat(rep.lat_entrega || 0);
    let lng = parseFloat(rep.lng_entrega || 0);

    if (!lat || !lng) {

      const g = await geocode(rep.endereco_entrega);

      if (g) {

        lat = g.lat;
        lng = g.lng;

        for (const p of grupo) {

          await db.from('entregas')
          .update({ lat_entrega: lat, lng_entrega: lng })
          .eq('id', p.id);

        }

      }

    }

    const dist = distKm(baseLat, baseLng, lat, lng);
    const ang = ((angleDeg(baseLat, baseLng, lat, lng) % 360 + 360) % 360);

    paradasGeo.push({
      ids: grupo.map(p => p.id),
      labels: grupo.map(p => p.numero_pedido ? '#' + p.numero_pedido : p.cliente_nome || 'Entrega'),
      end: rep.endereco_entrega,
      lat,
      lng,
      dist,
      ang,
      qtdPeds: grupo.length
    });

  }


  paradasGeo.sort((a,b)=>a.dist-b.dist);


  const grupos_ent = entregadores.map(ent => ({
    entId: ent.id,
    entNome: ent.nome,
    limite: limiteGlobal || 10,
    paradas: [],
    ultimaLat: baseLat,
    ultimaLng: baseLng
  }));


  const naoAtribuidas = [...paradasGeo];


  while (naoAtribuidas.length > 0) {

    for (const g of grupos_ent) {

      if (!naoAtribuidas.length) break;

      let melhor = 0;
      let melhorDist = Infinity;

      naoAtribuidas.forEach((p,i)=>{

        const d = distKm(g.ultimaLat,g.ultimaLng,p.lat,p.lng);

        if(d<melhorDist){

          melhorDist=d;
          melhor=i;

        }

      });

      const parada = naoAtribuidas.splice(melhor,1)[0];

      g.paradas.push(parada);

      g.ultimaLat = parada.lat;
      g.ultimaLng = parada.lng;

    }

  }


  const resultado = grupos_ent
  .filter(g=>g.paradas.length>0)
  .map(g=>{

    const pedidosFlat = g.paradas.flatMap(parada =>
      parada.ids.map((id,idx)=>{

        const dist = parada.dist;

        const valor = taxaConfig
          ? calcularValorCorrida(
            dist,
            taxaConfig.taxa_tipo,
            taxaConfig.taxa_entrega,
            taxaConfig.taxa_km_limite,
            taxaConfig.taxa_km_excedente,
            taxaConfig.taxa_fixo_base
          )
          : 0;

        return {

          id,
          num:(parada.labels[idx]||'').replace(/^#/,''),
          end:parada.end,
          dist:parseFloat(dist.toFixed(2)),
          valor:parseFloat(valor.toFixed(2))

        }

      })
    );


    return{

      entId:g.entId,
      entNome:g.entNome,
      pedidos:pedidosFlat,
      totalParadas:g.paradas.length,
      totalPedidos:pedidosFlat.length,
      kmTotal:parseFloat(g.paradas.reduce((s,p)=>s+p.dist,0).toFixed(2))

    }

  });


  return{

    grupos:resultado,
    totalPedidos:pedidos.length,
    totalParadas:paradasGeo.length,
    totalEntregadores:resultado.length

  }

}


// ─────────────────────────────────────────────────
// HANDLER API
// ─────────────────────────────────────────────────

module.exports = async function handler(req,res){

  const origin = req.headers.origin || '';

  const allowedOrigins=[
    'https://monta-a-rota-ai-frontend.vercel.app',
    'https://montarotai.vercel.app',
    'http://localhost:3000'
  ];

  if(allowedOrigins.includes(origin)){
    res.setHeader('Access-Control-Allow-Origin',origin);
  }

  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');

  if(req.method==='OPTIONS') return res.status(200).end();

  if(req.method!=='POST'){
    return res.status(405).json({error:'Método não permitido'});
  }

  try{

    const {lojaId, limiteGlobal, distribuicao}=req.body;

    if(!lojaId) return res.status(400).json({error:'lojaId obrigatório'});

    const db=createClient(SB_URL,SB_KEY);

    const {data:user}=await db
    .from('usuarios')
    .select('id,tipo,taxa_tipo,taxa_entrega,taxa_km_limite,taxa_km_excedente,taxa_fixo_base,loja_lat,loja_lng')
    .eq('id',lojaId)
    .single();

    if(!user) return res.status(403).json({error:'Loja não encontrada'});


    const {data:pedidos}=await db
    .from('entregas')
    .select('id,numero_pedido,cliente_nome,endereco_entrega,lat_entrega,lng_entrega')
    .eq('loja_id',lojaId)
    .eq('status','pendente');

    if(!pedidos || !pedidos.length){

      return res.status(200).json({
        grupos:[],
        totalPedidos:0,
        totalParadas:0
      });

    }


    const entregadores=(distribuicao||[]).map(([id,v])=>({
      id,
      nome:v.nome
    }));


    const resultado = await otimizarRota({

      pedidos,
      entregadores,
      lojaLat:user.loja_lat,
      lojaLng:user.loja_lng,
      limiteGlobal:limiteGlobal || 10,
      taxaConfig:{
        taxa_tipo:user.taxa_tipo,
        taxa_entrega:user.taxa_entrega,
        taxa_km_limite:user.taxa_km_limite,
        taxa_km_excedente:user.taxa_km_excedente,
        taxa_fixo_base:user.taxa_fixo_base
      }

    });


    return res.status(200).json(resultado);

  }
  catch(err){

    console.error('[calcular-rota]',err);

    return res.status(500).json({
      error:'Erro interno no servidor'
    });

  }

};
