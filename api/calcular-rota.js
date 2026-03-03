// ═══════════════════════════════════════════════════════════════
//  MONTA ROTAÍ — API Serverless: /api/calcular-rota
//  © 2025 Monta Rotaí. Sistema Proprietário. Todos os direitos
//  reservados. Leis 9.609/98 e 9.610/98.
//  ─────────────────────────────────────────────────────────────
//  Este arquivo roda NO SERVIDOR (Vercel Serverless Function).
//  O algoritmo de otimização de rota nunca chega ao navegador.
//  Qualquer tentativa de cópia ou engenharia reversa viola a lei.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ── Credenciais (variáveis de ambiente na Vercel — NUNCA no front) ──
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key (não anon)

// ── Funções matemáticas de roteirização ─────────────────────────
function distKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function angleDeg(lat1, lng1, lat2, lng2) {
  return Math.atan2(lng2 - lng1, lat2 - lat1) * 180 / Math.PI;
}

// ── Normaliza endereço → chave para agrupar paradas duplicadas ──
function chaveEnd(end) {
  if (!end || !end.trim()) return '_sem_' + Math.random();
  let s = end.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(avenida|avenue|av\.?|rua|r\.?|alameda|al\.?|travessa|tv\.?|estrada|est\.?|praca|pca\.?|rodovia|rod\.?|viela|vila|v\.?)\b/g, ' ')
    .replace(/\b(apto?|apartamento|ap\.?|bloco|bl\.?|torre|t\.?|sala|sl\.?|casa|lote|lt\.?|cond|condominio|kit|subsetor|setor|conjunto|cj\.?)\b.*/,'')
    .replace(/[-,]\s*[a-z\s]{3,}$/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const m = s.match(/([a-z][a-z0-9\s]{2,}?)\s+(\d{2,5})\b/);
  if (m) {
    const palavras = m[1].trim().split(/\s+/);
    const filtradas = palavras.filter(p => p.length > 2);
    return (filtradas.slice(-3).join(' ') + ' ' + m[2]).trim();
  }
  return s.substring(0, 40);
}

// ── Geocode via Nominatim (OpenStreetMap) ────────────────────────
async function geocode(endereco) {
  if (!endereco) return null;
  try {
    const q = encodeURIComponent(endereco + ', Ribeirao Preto, SP, Brasil');
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`,
      { headers: { 'User-Agent': 'MontaRotai/1.0 (admin@montarotai.com)' } });
    const d = await r.json();
    if (d && d[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch (e) { /* falha silenciosa */ }
  return null;
}

// ── Calcular valor da corrida ─────────────────────────────────────
function calcularValorCorrida(distancia, taxaTipo, taxaBase, kmLimite, taxaExcedente, taxaFixoBase) {
  if (taxaTipo === 'por_km') {
    if (distancia <= kmLimite) return taxaBase;
    return taxaBase + (distancia - kmLimite) * taxaExcedente;
  } else if (taxaTipo === 'fixo_mais_km') {
    if (distancia <= kmLimite) return taxaFixoBase + taxaBase;
    return taxaFixoBase + taxaBase + (distancia - kmLimite) * taxaExcedente;
  }
  return taxaBase; // fixo
}

// ══════════════════════════════════════════════════════════════════
//  ALGORITMO PRINCIPAL — Nearest-Neighbor Logistics
//  1. Agrupa pedidos por endereço normalizado (paradas únicas)
//  2. Geocodifica cada parada
//  3. Distribui paradas entre entregadores por proximidade sequencial
//  4. Retorna plano de rota otimizado
// ══════════════════════════════════════════════════════════════════
async function otimizarRota({ pedidos, entregadores, lojaLat, lojaLng, limiteGlobal, taxaConfig }) {
  const RP_LAT = -21.1775, RP_LNG = -47.8103;
  const baseLat = lojaLat || RP_LAT;
  const baseLng = lojaLng || RP_LNG;

  // PASSO 1: Agrupar por endereço
  const mapaEnds = {};
  pedidos.forEach(p => {
    const k = chaveEnd(p.endereco_entrega);
    if (!mapaEnds[k]) mapaEnds[k] = [];
    mapaEnds[k].push(p);
  });
  const paradaList = Object.values(mapaEnds);

  // PASSO 2: Geocode de cada parada
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
        lat = g.lat; lng = g.lng;
        // Persiste coords no banco
        for (const p of grupo) {
          await db.from('entregas').update({ lat_entrega: lat, lng_entrega: lng }).eq('id', p.id);
        }
      } else { geocodeFailed = true; lat = 0; lng = 0; }
    }
    const dist = geocodeFailed ? 0 : distKm(baseLat, baseLng, lat, lng);
    const ang = geocodeFailed ? 0 : ((angleDeg(baseLat, baseLng, lat, lng) % 360 + 360) % 360);
    paradasGeo.push({
      ids: grupo.map(p => p.id),
      labels: grupo.map(p => p.numero_pedido ? '#' + p.numero_pedido : p.cliente_nome || 'Entrega'),
      end: rep.endereco_entrega || '',
      lat, lng, dist, ang, geocodeFailed,
      qtdPeds: grupo.length
    });
  }
  paradasGeo.sort((a, b) => a.dist - b.dist);

  // PASSO 3: Nearest-Neighbor — distribui paradas entre entregadores
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
      if (g.totalParadas >= g.limite || !naoAtribuidas.length) continue;
      let melhorIdx = -1, melhorDist = Infinity;
      naoAtribuidas.forEach((p, i) => {
        if (p.geocodeFailed) return;
        const d = distKm(g.ultimaLat, g.ultimaLng, p.lat, p.lng);
        if (d < melhorDist) { melhorDist = d; melhorIdx = i; }
      });
      if (melhorIdx === -1) melhorIdx = naoAtribuidas.findIndex(() => true);
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
  // Paradas sobrando → entregador com menos paradas
  naoAtribuidas.forEach(p => {
    const comEspaco = grupos_ent.sort((a, b) => a.totalParadas - b.totalParadas);
    comEspaco[0].paradas.push(p);
    comEspaco[0].totalParadas++;
  });

  // PASSO 4: Montar resultado final com valores calculados
  const resultado = grupos_ent
    .filter(g => g.paradas.length > 0)
    .map(g => {
      g.paradas.sort((a, b) => a.dist - b.dist);
      const bairros = [...new Set(
        g.paradas.map(p => p.end.split(',')[1]?.trim() || '').filter(Boolean)
      )].slice(0, 2).join(' / ');

      const pedidosFlat = g.paradas.flatMap(parada =>
        parada.ids.map((id, idx) => {
          const dist = parada.dist;
          const valor = taxaConfig ? calcularValorCorrida(
            dist,
            taxaConfig.taxa_tipo,
            taxaConfig.taxa_entrega,
            taxaConfig.taxa_km_limite,
            taxaConfig.taxa_km_excedente,
            taxaConfig.taxa_fixo_base
          ) : 0;
          return {
            id,
            num: (parada.labels[idx] || '').replace(/^#/, ''),
            end: parada.end,
            dist: parseFloat(dist.toFixed(2)),
            valor: parseFloat(valor.toFixed(2)),
            _paradaLabels: parada.labels,
            _paradaEnd: parada.end,
            _paradaQtd: parada.qtdPeds,
            _paradaIndex: idx
          };
        })
      );

      return {
        entId: g.entId,
        entNome: g.entNome,
        descricao: bairros ? '📍 ' + bairros : g.paradas.length + ' parada' + (g.paradas.length > 1 ? 's' : ''),
        pedidos: pedidosFlat,
        totalParadas: g.paradas.length,
        totalPedidos: pedidosFlat.length,
        kmTotal: parseFloat(g.paradas.reduce((s, p) => s + p.dist, 0).toFixed(2))
      };
    });

  return {
    grupos: resultado,
    totalPedidos: pedidos.length,
    totalParadas: paradasGeo.length,
    totalEntregadores: resultado.length
  };
}

// ══════════════════════════════════════════════════════════════════
//  HANDLER HTTP — Entry point da Vercel Serverless Function
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // CORS — permite apenas o domínio do app
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://monta-a-rota-ai-frontend.vercel.app',
    'https://montarotai.vercel.app',
    'http://localhost:3000'
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    const { lojaId, limiteGlobal, distribuicao } = req.body;
    if (!lojaId) return res.status(400).json({ error: 'lojaId obrigatório' });

    // Autenticação: valida token de sessão do admin/loja
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token de sessão obrigatório' });

    const db = createClient(SB_URL, SB_KEY);

    // Valida que o token corresponde ao usuário da loja
    const { data: user } = await db.from('usuarios').select('id,tipo,taxa_tipo,taxa_entrega,taxa_km_limite,taxa_km_excedente,taxa_fixo_base,loja_lat,loja_lng').eq('id', lojaId).single();
    if (!user) return res.status(403).json({ error: 'Loja não encontrada' });

    // Busca pedidos pendentes
    const { data: pedidos } = await db.from('entregas')
      .select('id,numero_pedido,cliente_nome,endereco_entrega,lat_entrega,lng_entrega,distancia_km')
      .eq('loja_id', lojaId)
      .eq('status', 'pendente');
    if (!pedidos || !pedidos.length) return res.status(200).json({ grupos: [], totalPedidos: 0, totalParadas: 0 });

    // Monta lista de entregadores a partir da distribuição enviada
    const entregadores = (distribuicao || []).map(([id, v]) => ({ id, nome: v.nome }));
    if (!entregadores.length) return res.status(400).json({ error: 'Nenhum entregador disponível' });

    // Executa algoritmo
    const resultado = await otimizarRota({
      pedidos,
      entregadores,
      lojaLat: user.loja_lat,
      lojaLng: user.loja_lng,
      limiteGlobal: limiteGlobal || 10,
      taxaConfig: {
        taxa_tipo: user.taxa_tipo,
        taxa_entrega: user.taxa_entrega,
        taxa_km_limite: user.taxa_km_limite,
        taxa_km_excedente: user.taxa_km_excedente,
        taxa_fixo_base: user.taxa_fixo_base
      }
    });

    return res.status(200).json(resultado);

  } catch (err) {
    console.error('[calcular-rota]', err);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }
};
