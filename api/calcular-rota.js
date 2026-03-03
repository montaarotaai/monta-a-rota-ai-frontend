// ═══════════════════════════════════════════════════════════════
//  MONTA ROTAÍ — API Serverless: /api/calcular-rota
//  © 2025 Monta Rotaí. Sistema Proprietário. Todos os direitos
//  reservados. Leis 9.609/98 e 9.610/98.
//  ─────────────────────────────────────────────────────────────
//  Este arquivo roda NO SERVIDOR (Vercel Serverless Function).
//  O algoritmo de otimização de rota nunca chega ao navegador.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ── Credenciais (variáveis de ambiente na Vercel) ──
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;


// ─────────────────────────────────────────────────
// FUNÇÕES MATEMÁTICAS
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

  let s = end
    .toLowerCase()
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
      {
        headers: {
          'User-Agent': 'MontaRotai/1.0 (admin@montarotai.com)'
        }
      }
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
// CÁLCULO DE VALOR
// ─────────────────────────────────────────────────

function calcularValorCorrida(
  distancia,
  taxaTipo,
  taxaBase,
  kmLimite,
  taxaExcedente,
  taxaFixoBase
) {

  if (taxaTipo === 'por_km') {

    if (distancia <= kmLimite) return taxaBase;

    return taxaBase + (distancia - kmLimite) * taxaExcedente;
  }

  if (taxaTipo === 'fixo_mais_km') {

    if (distancia <= kmLimite)
      return taxaFixoBase + taxaBase;

    return (
      taxaFixoBase +
      taxaBase +
      (distancia - kmLimite) * taxaExcedente
    );
  }

  return taxaBase;
}


// ─────────────────────────────────────────────────
// ALGORITMO DE ROTA
// ─────────────────────────────────────────────────

async function otimizarRota({
  pedidos,
  entregadores,
  lojaLat,
  lojaLng,
  limiteGlobal,
  taxaConfig
}) {

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

    let geocodeFailed = false;

    if (!lat || !lng) {

      const g = await geocode(rep.endereco_entrega);

      if (g) {

        lat = g.lat;
        lng = g.lng;

        for (const p of grupo) {

          await db
            .from('entregas')
            .update({
              lat_entrega: lat,
              lng_entrega: lng
            })
            .eq('id', p.id);

        }

      } else {

        geocodeFailed = true;
        lat = 0;
        lng = 0;

      }

    }

    const dist = geocodeFailed
      ? 0
      : distKm(baseLat, baseLng, lat, lng);

    const ang = geocodeFailed
      ? 0
      : ((angleDeg(baseLat, baseLng, lat, lng) % 360 + 360) % 360);

    paradasGeo.push({
      ids: grupo.map(p => p.id),
      labels: grupo.map(p =>
        p.numero_pedido
          ? '#' + p.numero_pedido
          : p.cliente_nome || 'Entrega'
      ),
      end: rep.endereco_entrega || '',
      lat,
      lng,
      dist,
      ang,
      geocodeFailed,
      qtdPeds: grupo.length
    });

  }


  paradasGeo.sort((a, b) => a.dist - b.dist);


  const limite = limiteGlobal || 10;

  const grupos_ent = entregadores.map(ent => ({
    entId: ent.id,
    entNome: ent.nome,
    limite,
    paradas: [],
    totalParadas: 0,
    ultimaLat: baseLat,
    ultimaLng: baseLng
  }));


  const naoAtribuidas = [...paradasGeo];

  let progresso = true;


  while (progresso && naoAtribuidas.length > 0) {

    progresso = false;

    for (const g of grupos_ent) {

      if (g.totalParadas >= g.limite || !naoAtribuidas.length)
        continue;

      let melhorIdx = -1;
      let melhorDist = Infinity;

      naoAtribuidas.forEach((p, i) => {

        if (p.geocodeFailed) return;

        const d = distKm(
          g.ultimaLat,
          g.ultimaLng,
          p.lat,
          p.lng
        );

        if (d < melhorDist) {

          melhorDist = d;
          melhorIdx = i;

        }

      });

      if (melhorIdx === -1)
        melhorIdx = naoAtribuidas.findIndex(() => true);

      if (melhorIdx >= 0) {

        const p = naoAtribuidas.splice(melhorIdx, 1)[0];

        g.paradas.push(p);

        g.totalParadas++;

        g.ultimaLat = p.lat || g.ultimaLat;
        g.ultimaLng = p.lng || g.ultimaLng;

        progresso = true;

      }

    }

  }


  naoAtribuidas.forEach(p => {

    const comEspaco = grupos_ent.sort(
      (a, b) => a.totalParadas - b.totalParadas
    );

    comEspaco[0].paradas.push(p);

    comEspaco[0].totalParadas++;

  });


  const resultado = grupos_ent
    .filter(g => g.paradas.length > 0)
    .map(g => {

      g.paradas.sort((a, b) => a.dist - b.dist);

      const pedidosFlat = g.paradas.flatMap(parada =>
        parada.ids.map((id, idx) => {

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
            num: (parada.labels[idx] || '').replace(/^#/, ''),
            end: parada.end,
            dist: parseFloat(dist.toFixed(2)),
            valor: parseFloat(valor.toFixed(2))
          };

        })
      );

      return {
        entId: g.entId,
        entNome: g.entNome,
        pedidos: pedidosFlat,
        totalParadas: g.paradas.length,
        totalPedidos: pedidosFlat.length
      };

    });


  return {
    grupos: resultado,
    totalPedidos: pedidos.length,
    totalParadas: paradasGeo.length
  };

}


// ─────────────────────────────────────────────────
// HANDLER DA API
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

    if (!lojaId)
      return res.status(400).json({ error: 'lojaId obrigatório' });

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

    return res.status(500).json({
      error: 'Erro interno no servidor'
    });

  }

};
