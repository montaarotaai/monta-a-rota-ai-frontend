// ═══════════════════════════════════════════════════════════════
//  MONTA ROTAÍ — API Serverless: /api/calcular-rota
//  © 2025 Monta Rotaí. Sistema Proprietário.
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


  // CLUSTERIZAÇÃO ANGULAR

  paradasGeo.sort((a, b) => a.ang - b.ang);

  const grupos_ent = entregadores.map(ent => ({
    entId: ent.id,
    entNome: ent.nome,
    paradas: []
  }));

  const clusterSize = Math.ceil(paradasGeo.length / grupos_ent.length);

  const clusters = [];

  for (let i = 0; i < paradasGeo.length; i += clusterSize) {
    clusters.push(paradasGeo.slice(i, i + clusterSize));
  }

  clusters.forEach((cluster, i) => {

    if (!grupos_ent[i]) return;

    grupos_ent[i].paradas = cluster;

  });


  // NEAREST DENTRO DO CLUSTER

  grupos_ent.forEach(g => {

    const ordenadas = [];
    const restantes = [...g.paradas];

    let latAtual = baseLat;
    let lngAtual = baseLng;

    while (restantes.length > 0) {

      let melhor = 0;
      let melhorDist = Infinity;

      restantes.forEach((p, i) => {

        const d = distKm(latAtual, lngAtual, p.lat, p.lng);

        if (d < melhorDist) {

          melhorDist = d;
          melhor = i;

        }

      });

      const proxima = restantes.splice(melhor, 1)[0];

      ordenadas.push(proxima);

      latAtual = proxima.lat;
      lngAtual = proxima.lng;

    }

    g.paradas = ordenadas;

  });


  const resultado = grupos_ent
  .filter(g => g.paradas.length > 0)
  .map(g => ({

    entId: g.entId,
    entNome: g.entNome,
    pedidos: g.paradas,
    totalParadas: g.paradas.length

  }));


  return {

    grupos: resultado,
    totalPedidos: pedidos.length,
    totalParadas: paradasGeo.length

  };

}


// ─────────────────────────────────────────────────
// HANDLER API
// ─────────────────────────────────────────────────

module.exports = async function handler(req, res) {

  const origin = req.headers.origin || '';

  const allowedOrigins = [
    'https://monta-a-rota-ai-frontend.vercel.app',
    'https://montarotai.vercel.app',
    'http://localhost:3000'
  ];

  if (!allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Acesso não autorizado' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {

    const { lojaId, limiteGlobal, distribuicao } = req.body;

    if (!lojaId) {
      return res.status(400).json({ error: 'lojaId obrigatório' });
    }

    const db = createClient(SB_URL, SB_KEY);

    const { data: pedidos } = await db
      .from('entregas')
      .select('*')
      .eq('loja_id', lojaId)
      .eq('status', 'pendente');

    const entregadores = (distribuicao || []).map(([id, v]) => ({
      id,
      nome: v.nome
    }));

    const resultado = await otimizarRota({
      pedidos,
      entregadores,
      limiteGlobal
    });

    return res.status(200).json(resultado);

  } catch (err) {

    console.error('[calcular-rota]', err);

    return res.status(500).json({ error: 'Erro interno no servidor' });

  }

};
