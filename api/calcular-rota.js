// ═══════════════════════════════════════════════════════════════
//  MONTA ROTAÍ — API Serverless: /api/calcular-rota  v3
//  © 2025 Monta Rotaí. Sistema Proprietário. Todos os direitos
//  reservados. Leis 9.609/98 e 9.610/98.
//  ─────────────────────────────────────────────────────────────
//  ALGORITMO v3: Agrupamento por bairro/distrito REAL via
//  reverse geocode do OpenStreetMap — não mais por ângulo.
//  Paradas do mesmo bairro ou bairros adjacentes vão juntas.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Distância Haversine ──────────────────────────────────────────
function distKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Normaliza nome de bairro para comparação ─────────────────────
function normBairro(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(jardim|jd|vila|vl|parque|pq|conjunto|cj|residencial|res|distrito|dt|subsetor|setor)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ── MAPA DE ADJACÊNCIA DE BAIRROS — Ribeirão Preto ──────────────
// Bairros que fazem sentido ir juntos na mesma rota.
// Baseado na geografia real da cidade: eixos viários, regiões.
// Cada bairro lista seus vizinhos diretos (quem pode ir junto).
const ADJACENCIA_RP = {
  // ── ZONA SUL / BONFIM ────────────────────────────────────────
  'bonfim paulista':      ['recreio das acácias', 'parque bonfim', 'jardim paulistano', 'jardim iraja', 'campos eliseos', 'subsetor sul'],
  'recreio das acácias':  ['bonfim paulista', 'parque bonfim', 'subsetor sul'],
  'parque bonfim':        ['bonfim paulista', 'recreio das acácias', 'jardim iraja'],
  'jardim iraja':         ['parque bonfim', 'bonfim paulista', 'campos eliseos', 'jardim paulistano'],
  'subsetor sul':         ['bonfim paulista', 'recreio das acácias', 'jardim paulistano', 'ribeirao verde'],
  'ribeirao verde':       ['subsetor sul', 'jardim paulistano'],

  // ── ZONA SUL / CAMPOS ELÍSEOS e entorno ─────────────────────
  'campos eliseos':       ['jardim iraja', 'bonfim paulista', 'jardim paulistano', 'alto da boa vista', 'jardim america'],
  'jardim paulistano':    ['campos eliseos', 'bonfim paulista', 'subsetor sul', 'jardim iraja', 'alto da boa vista'],
  'alto da boa vista':    ['campos eliseos', 'jardim paulistano', 'jardim america', 'jardim sumare'],
  'jardim america':       ['alto da boa vista', 'campos eliseos', 'jardim sumare', 'centro'],
  'jardim sumare':        ['alto da boa vista', 'jardim america', 'centro'],

  // ── CENTRO ──────────────────────────────────────────────────
  'centro':               ['jardim america', 'jardim sumare', 'republica', 'campos eliseos', 'jardim paulista', 'alto da boa vista'],
  'republica':            ['centro', 'jardim paulista', 'jardim america'],
  'jardim paulista':      ['centro', 'republica', 'jardim paulistano'],

  // ── ZONA NORTE ───────────────────────────────────────────────
  'jardim pauliceia':     ['nova alianca', 'parque industrial lagoinha', 'jardim botanico', 'jardim nazareth'],
  'nova alianca':         ['jardim pauliceia', 'parque industrial lagoinha', 'jardim botânico'],
  'jardim botanico':      ['nova alianca', 'jardim pauliceia', 'jardim nazareth'],
  'jardim nazareth':      ['jardim botanico', 'jardim pauliceia', 'lagoinha'],
  'lagoinha':             ['jardim nazareth', 'parque industrial lagoinha'],
  'parque industrial lagoinha': ['nova alianca', 'jardim pauliceia', 'lagoinha'],

  // ── ZONA LESTE ───────────────────────────────────────────────
  'jardim juliana':       ['vila virginia', 'jardim zara', 'jardim pedro mello'],
  'vila virginia':        ['jardim juliana', 'jardim zara'],
  'jardim zara':          ['vila virginia', 'jardim juliana', 'jardim pedro mello'],
  'jardim pedro mello':   ['jardim juliana', 'jardim zara', 'jardim brasiliano'],
  'jardim brasiliano':    ['jardim pedro mello', 'jardim caxambu'],
  'jardim caxambu':       ['jardim brasiliano', 'jardim pedro mello'],

  // ── ZONA OESTE ───────────────────────────────────────────────
  'jardim irajá':         ['jardim iraja', 'campos eliseos', 'bonfim paulista'],
  'jardim abussafe':      ['jardim iraja', 'jardim pauliceia'],
  'jardim california':    ['jardim abussafe', 'nova alianca'],
};

// ── Calcula compatibilidade entre dois bairros (0=incompatível, 1=mesmo, 0.7=adjacente) ──
function compatBairros(b1, b2) {
  if (!b1 || !b2) return 0.3; // sem info = tenta junto
  const n1 = normBairro(b1);
  const n2 = normBairro(b2);
  if (n1 === n2) return 1.0;

  // Verifica adjacência no mapa
  const vizinhos1 = ADJACENCIA_RP[n1] || [];
  const vizinhos2 = ADJACENCIA_RP[n2] || [];
  if (vizinhos1.some(v => normBairro(v) === n2)) return 0.75;
  if (vizinhos2.some(v => normBairro(v) === n1)) return 0.75;

  // Verifica vizinhos de vizinhos (2 graus de separação = ainda aceitável)
  for (const v of vizinhos1) {
    const vizinhosV = ADJACENCIA_RP[normBairro(v)] || [];
    if (vizinhosV.some(vv => normBairro(vv) === n2)) return 0.4;
  }

  return 0.0; // bairros distantes — não agrupar
}

// ── Normaliza chave de endereço para deduplicar paradas ─────────
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

// ── Geocode: lat/lng via Nominatim ──────────────────────────────
async function geocode(endereco) {
  if (!endereco) return null;
  try {
    const q = encodeURIComponent(endereco + ', Ribeirao Preto, SP, Brasil');
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`,
      { headers: { 'User-Agent': 'MontaRotai/1.0 (admin@montarotai.com)' } }
    );
    const d = await r.json();
    if (d && d[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch (e) {}
  return null;
}

// ── Reverse geocode: descobre o BAIRRO REAL a partir de lat/lng ──
// Usa Nominatim /reverse com zoom=16 (nível de bairro)
async function reverseGeocodeBairro(lat, lng) {
  if (!lat || !lng) return null;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`,
      { headers: { 'User-Agent': 'MontaRotai/1.0 (admin@montarotai.com)' } }
    );
    const d = await r.json();
    if (!d || !d.address) return null;
    // Prioridade: suburb > neighbourhood > quarter > city_district
    const bairro = d.address.suburb
      || d.address.neighbourhood
      || d.address.quarter
      || d.address.city_district
      || d.address.county
      || null;
    return bairro;
  } catch (e) {}
  return null;
}

// ── Calcula valor da corrida ─────────────────────────────────────
function calcularValorCorrida(distancia, taxaTipo, taxaBase, kmLimite, taxaExcedente, taxaFixoBase) {
  if (taxaTipo === 'por_km') {
    if (distancia <= kmLimite) return taxaBase;
    return taxaBase + (distancia - kmLimite) * taxaExcedente;
  } else if (taxaTipo === 'fixo_mais_km') {
    if (distancia <= kmLimite) return taxaFixoBase + taxaBase;
    return taxaFixoBase + taxaBase + (distancia - kmLimite) * taxaExcedente;
  }
  return taxaBase;
}

// ── Pausa mínima entre requests ao Nominatim (respeita rate limit) ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════════════════════
//  ALGORITMO PRINCIPAL v3 — Cluster por Bairro Real (OSM)
//
//  1. Geocodifica cada parada (lat/lng)
//  2. Faz REVERSE GEOCODE → descobre o BAIRRO REAL no OSM
//  3. Agrupa paradas por bairro (usando mapa de adjacência RP)
//  4. Atribui clusters de bairros a entregadores (sem dividir
//     bairros entre entregadores — máxima eficiência)
//  5. Dentro de cada rota, ordena por distância da loja
//  6. Sinaliza pedidos extras do mesmo cluster que cabem na rota
// ══════════════════════════════════════════════════════════════════
async function otimizarRota({ pedidos, entregadores, lojaLat, lojaLng, limiteGlobal, taxaConfig }) {
  const RP_LAT = -21.1775, RP_LNG = -47.8103;
  const baseLat = lojaLat || RP_LAT;
  const baseLng = lojaLng || RP_LNG;
  const db = createClient(SB_URL, SB_KEY);

  // ── PASSO 1: Agrupar por endereço (deduplicar paradas) ──────────
  const mapaEnds = {};
  pedidos.forEach(p => {
    const k = chaveEnd(p.endereco_entrega);
    if (!mapaEnds[k]) mapaEnds[k] = [];
    mapaEnds[k].push(p);
  });
  const paradaList = Object.values(mapaEnds);

  // ── PASSO 2: Geocode + Reverse Geocode de cada parada ───────────
  const paradasGeo = [];
  for (const grupo of paradaList) {
    const rep = grupo[0];
    let lat = parseFloat(rep.lat_entrega || 0);
    let lng = parseFloat(rep.lng_entrega || 0);
    let bairro = rep.bairro_geocodificado || null;
    let geocodeFailed = false;

    // 2a. Geocode se não tiver coordenadas
    if (!lat || !lng) {
      await sleep(300); // respeita rate limit Nominatim
      const g = await geocode(rep.endereco_entrega);
      if (g) {
        lat = g.lat; lng = g.lng;
        for (const p of grupo) {
          await db.from('entregas').update({ lat_entrega: lat, lng_entrega: lng }).eq('id', p.id);
        }
      } else { geocodeFailed = true; lat = 0; lng = 0; }
    }

    // 2b. Reverse geocode → bairro real do OSM
    if (!geocodeFailed && !bairro) {
      await sleep(300);
      bairro = await reverseGeocodeBairro(lat, lng);
      // Persiste o bairro para não consultar de novo
      if (bairro) {
        for (const p of grupo) {
          await db.from('entregas').update({ bairro_geocodificado: bairro }).eq('id', p.id).catch(() => {});
        }
      }
    }

    const dist = geocodeFailed ? 0 : distKm(baseLat, baseLng, lat, lng);
    paradasGeo.push({
      ids: grupo.map(p => p.id),
      labels: grupo.map(p => p.numero_pedido ? '#' + p.numero_pedido : p.cliente_nome || 'Entrega'),
      end: rep.endereco_entrega || '',
      lat, lng, dist, geocodeFailed,
      bairro: bairro || 'Sem bairro',
      bairroNorm: normBairro(bairro || ''),
      qtdPeds: grupo.length
    });
  }

  // Ordena por distância (mais próximo primeiro)
  paradasGeo.sort((a, b) => a.dist - b.dist);
  const limite = limiteGlobal || 10;

  // ── PASSO 3: Clustering por bairro ──────────────────────────────
  // Agrupa paradas cujos bairros são compatíveis (mesmo ou adjacente)
  // Algoritmo Union-Find simplificado
  const clusters = []; // array de arrays de paradas

  for (const parada of paradasGeo) {
    // Tenta encaixar em cluster existente compatível
    let melhorCluster = null;
    let melhorScore = 0;

    for (const cluster of clusters) {
      // Compatibilidade = média com todos os bairros do cluster
      let totalScore = 0;
      for (const p of cluster) {
        totalScore += compatBairros(parada.bairro, p.bairro);
      }
      const avgScore = totalScore / cluster.length;
      if (avgScore > 0.5 && avgScore > melhorScore) {
        melhorScore = avgScore;
        melhorCluster = cluster;
      }
    }

    if (melhorCluster) {
      melhorCluster.push(parada);
    } else {
      clusters.push([parada]); // novo cluster
    }
  }

  // ── PASSO 4: Distribui clusters entre entregadores ───────────────
  // Ordena clusters por tamanho (maior primeiro = mais eficiente)
  clusters.sort((a, b) => b.length - a.length);

  const grupos_ent = entregadores.map(ent => ({
    entId: ent.id,
    entNome: ent.nome,
    paradas: [],
    bairros: new Set(),
    totalParadas: 0,
    totalKm: 0
  }));

  // Atribui cada cluster ao entregador com mais afinidade e espaço
  const clustersNaoAtribuidos = [...clusters];

  for (const cluster of clustersNaoAtribuidos) {
    // Encontra entregador com mais espaço e maior compatibilidade de bairros
    let melhorEnt = null;
    let melhorScore = -1;

    for (const g of grupos_ent) {
      if (g.totalParadas >= limite) continue;
      // Score = espaço disponível + afinidade de bairros já atribuídos
      const espaco = (limite - g.totalParadas) / limite;
      let afinidade = 1.0; // se vazio, aceita qualquer cluster
      if (g.bairros.size > 0) {
        let totalAfin = 0;
        let pares = 0;
        for (const p of cluster) {
          for (const bairroExistente of g.bairros) {
            totalAfin += compatBairros(p.bairro, bairroExistente);
            pares++;
          }
        }
        afinidade = pares > 0 ? totalAfin / pares : 0;
      }
      const score = espaco * 0.4 + afinidade * 0.6;
      if (score > melhorScore) { melhorScore = score; melhorEnt = g; }
    }

    if (!melhorEnt) melhorEnt = grupos_ent.reduce((a, b) => a.totalParadas <= b.totalParadas ? a : b);

    // Adiciona paradas do cluster ao entregador, respeitando limite
    for (const p of cluster) {
      if (melhorEnt.totalParadas >= limite) break;
      melhorEnt.paradas.push(p);
      melhorEnt.bairros.add(p.bairro);
      melhorEnt.totalParadas++;
      melhorEnt.totalKm += p.dist;
    }
  }

  // ── PASSO 5: SUGESTÃO INTELIGENTE ───────────────────────────────
  // Detecta paradas que ficaram em outro entregador mas são do mesmo
  // bairro/cluster de um entregador — e sugere realocação
  const sugestoesExtras = {};
  grupos_ent.forEach(g => {
    if (!g.paradas.length) return;
    const extras = [];
    grupos_ent.forEach(outro => {
      if (outro.entId === g.entId) return;
      outro.paradas.forEach(p => {
        // Verifica se p tem bairro compatível com este entregador
        let afin = 0;
        g.bairros.forEach(b => { afin = Math.max(afin, compatBairros(p.bairro, b)); });
        if (afin >= 0.75) { // mesmo bairro ou adjacente direto
          extras.push({ end: p.end, labels: p.labels, dist: p.dist, bairro: p.bairro });
        }
      });
    });
    if (extras.length > 0) sugestoesExtras[g.entId] = extras;
  });

  // ── PASSO 6: Monta resultado ─────────────────────────────────────
  const resultado = grupos_ent
    .filter(g => g.paradas.length > 0)
    .map(g => {
      // Ordena paradas dentro da rota: mais próximo da loja primeiro
      g.paradas.sort((a, b) => a.dist - b.dist);

      // Rota sequencial: ordena por proximidade encadeada (nearest neighbor dentro do grupo)
      const rotaOrdenada = [];
      const naoVisitadas = [...g.paradas];
      let ultimaLat = baseLat, ultimaLng = baseLng;
      while (naoVisitadas.length) {
        let melhorIdx = 0, melhorD = Infinity;
        naoVisitadas.forEach((p, i) => {
          const d = distKm(ultimaLat, ultimaLng, p.lat || ultimaLat, p.lng || ultimaLng);
          if (d < melhorD) { melhorD = d; melhorIdx = i; }
        });
        const prox = naoVisitadas.splice(melhorIdx, 1)[0];
        rotaOrdenada.push(prox);
        ultimaLat = prox.lat || ultimaLat;
        ultimaLng = prox.lng || ultimaLng;
      }

      const bairrosUnicos = [...new Set(rotaOrdenada.map(p => p.bairro).filter(Boolean))];
      const descricao = bairrosUnicos.slice(0, 3).join(' → ');

      const pedidosFlat = rotaOrdenada.flatMap(parada =>
        parada.ids.map((id, idx) => {
          const valor = taxaConfig ? calcularValorCorrida(
            parada.dist,
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
            dist: parseFloat(parada.dist.toFixed(2)),
            valor: parseFloat(valor.toFixed(2)),
            bairro: parada.bairro,
            _paradaLabels: parada.labels,
            _paradaEnd: parada.end,
            _paradaQtd: parada.qtdPeds,
            _paradaIndex: idx
          };
        })
      );

      const kmTotal = parseFloat(rotaOrdenada.reduce((s, p) => s + p.dist, 0).toFixed(2));
      const valorTotal = parseFloat(pedidosFlat.reduce((s, p) => s + p.valor, 0).toFixed(2));

      return {
        entId: g.entId,
        entNome: g.entNome,
        bairros: bairrosUnicos,
        setorNome: '📍 ' + (bairrosUnicos[0] || 'Sem bairro'),
        descricao,
        pedidos: pedidosFlat,
        totalParadas: rotaOrdenada.length,
        totalPedidos: pedidosFlat.length,
        kmTotal,
        valorTotal,
        sugestaoExtras: sugestoesExtras[g.entId] || []
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
//  HANDLER HTTP
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
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

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token de sessão obrigatório' });

    const db = createClient(SB_URL, SB_KEY);

    const { data: user } = await db.from('usuarios')
      .select('id,tipo,taxa_tipo,taxa_entrega,taxa_km_limite,taxa_km_excedente,taxa_fixo_base,loja_lat,loja_lng')
      .eq('id', lojaId).single();
    if (!user) return res.status(403).json({ error: 'Loja não encontrada' });

    const { data: pedidos } = await db.from('entregas')
      .select('id,numero_pedido,cliente_nome,endereco_entrega,lat_entrega,lng_entrega,distancia_km,bairro_geocodificado')
      .eq('loja_id', lojaId)
      .eq('status', 'pendente');
    if (!pedidos || !pedidos.length)
      return res.status(200).json({ grupos: [], totalPedidos: 0, totalParadas: 0 });

    const entregadores = (distribuicao || []).map(([id, v]) => ({ id, nome: v.nome }));
    if (!entregadores.length)
      return res.status(400).json({ error: 'Nenhum entregador disponível' });

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
