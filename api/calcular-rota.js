// ═══════════════════════════════════════════════════════════════
//  MONTA ROTAÍ — API Serverless: /api/calcular-rota  v2
//  © 2025 Monta Rotaí. Sistema Proprietário. Todos os direitos
//  reservados. Leis 9.609/98 e 9.610/98.
//  ─────────────────────────────────────────────────────────────
//  Este arquivo roda NO SERVIDOR (Vercel Serverless Function).
//  O algoritmo de otimização de rota nunca chega ao navegador.
//  Qualquer tentativa de cópia ou engenharia reversa viola a lei.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Funções matemáticas ──────────────────────────────────────────
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

// ── Determina setor geográfico (N/S/L/O/Centro) ──────────────────
// Retorna o setor baseado no ângulo e distância da loja
function getSetor(baseLat, baseLng, lat, lng) {
  if (!lat || !lng) return 'sem_coords';
  const dist = distKm(baseLat, baseLng, lat, lng);
  // Pedidos muito próximos = centro
  if (dist < 1.5) return 'centro';
  const ang = ((angleDeg(baseLat, baseLng, lat, lng) % 360) + 360) % 360;
  // Norte: 315-360 e 0-45 (cima no mapa)
  // Leste: 45-135
  // Sul: 135-225
  // Oeste: 225-315
  if (ang >= 315 || ang < 45) return 'norte';
  if (ang >= 45 && ang < 135) return 'leste';
  if (ang >= 135 && ang < 225) return 'sul';
  return 'oeste';
}

// ── Calcula compatibilidade de rota (setores similares = alta) ────
function compatibilidadeRota(setor1, setor2) {
  if (setor1 === setor2) return 1.0;
  // Setores adjacentes têm compatibilidade média
  const adjacentes = {
    'norte': ['leste', 'oeste', 'centro'],
    'sul': ['leste', 'oeste', 'centro'],
    'leste': ['norte', 'sul', 'centro'],
    'oeste': ['norte', 'sul', 'centro'],
    'centro': ['norte', 'sul', 'leste', 'oeste']
  };
  if (adjacentes[setor1]?.includes(setor2)) return 0.5;
  return 0.0; // setores opostos (N↔S, L↔O)
}

// ── Normaliza endereço ───────────────────────────────────────────
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

// ── Geocode via Nominatim ────────────────────────────────────────
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

// ── Calcular valor da corrida ────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════
//  ALGORITMO PRINCIPAL v2 — Roteamento por Setor Geográfico
//
//  Lógica:
//  1. Agrupa pedidos por endereço normalizado (paradas únicas)
//  2. Geocodifica cada parada
//  3. Classifica cada parada em SETOR (N/S/L/O/Centro)
//  4. Para cada entregador, atribui paradas do MESMO setor (máxima
//     eficiência logística — sem mandar 2 entregadores pro mesmo lado)
//  5. Ordena por distância (mais próximo da loja primeiro)
//  6. SUGESTÃO INTELIGENTE: Identifica pedidos extras no mesmo setor
//     que "caberiam na rota" mesmo acima do limite configurado
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

  // PASSO 2: Geocode + calcular setor para cada parada
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
        for (const p of grupo) {
          await db.from('entregas').update({ lat_entrega: lat, lng_entrega: lng }).eq('id', p.id);
        }
      } else { geocodeFailed = true; lat = 0; lng = 0; }
    }
    const dist = geocodeFailed ? 0 : distKm(baseLat, baseLng, lat, lng);
    const ang = geocodeFailed ? 0 : ((angleDeg(baseLat, baseLng, lat, lng) % 360 + 360) % 360);
    const setor = geocodeFailed ? 'centro' : getSetor(baseLat, baseLng, lat, lng);
    paradasGeo.push({
      ids: grupo.map(p => p.id),
      labels: grupo.map(p => p.numero_pedido ? '#' + p.numero_pedido : p.cliente_nome || 'Entrega'),
      end: rep.endereco_entrega || '',
      lat, lng, dist, ang, geocodeFailed,
      qtdPeds: grupo.length,
      setor
    });
  }
  // Ordena por distância (mais próximo primeiro — menor tempo de entrega)
  paradasGeo.sort((a, b) => a.dist - b.dist);

  const limite = limiteGlobal || 10;

  // PASSO 3: Distribuição por setor geográfico
  // Agrupa paradas por setor
  const setores = {};
  paradasGeo.forEach(p => {
    if (!setores[p.setor]) setores[p.setor] = [];
    setores[p.setor].push(p);
  });

  // Ordena setores por quantidade de pedidos (maior primeiro)
  const setoresOrdenados = Object.entries(setores)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([setor, paradas]) => ({ setor, paradas }));

  // Atribui um setor principal para cada entregador (greedy por volume)
  const grupos_ent = entregadores.map(ent => ({
    entId: ent.id,
    entNome: ent.nome,
    limite,
    paradas: [],
    totalParadas: 0,
    setor: null,
    totalKm: 0
  }));

  const naoAtribuidas = [...paradasGeo];
  const setoresUsados = new Set();

  // Primeira passagem: atribui setores únicos a cada entregador
  // Entregadores recebem setores em ordem de volume (mais pedidos = setor prioritário)
  grupos_ent.forEach((g, gi) => {
    // Tenta pegar um setor não usado ainda
    for (const { setor, paradas } of setoresOrdenados) {
      if (!setoresUsados.has(setor) && paradas.length > 0) {
        setoresUsados.add(setor);
        g.setor = setor;
        break;
      }
    }
    // Se não achou setor livre, pega qualquer um com mais paradas
    if (!g.setor && setoresOrdenados.length > 0) {
      g.setor = setoresOrdenados[gi % setoresOrdenados.length].setor;
    }
  });

  // Segunda passagem: distribui paradas respeitando setor do entregador
  // Ordena paradas por distância (mais próximo primeiro = menor tempo)
  for (const g of grupos_ent) {
    if (!g.setor) continue;
    // Pega paradas do setor principal, ordenadas por distância
    const paradasSetor = naoAtribuidas
      .filter(p => p.setor === g.setor)
      .sort((a, b) => a.dist - b.dist);

    for (const p of paradasSetor) {
      if (g.totalParadas >= g.limite) break;
      const idx = naoAtribuidas.indexOf(p);
      if (idx >= 0) {
        naoAtribuidas.splice(idx, 1);
        g.paradas.push(p);
        g.totalParadas++;
        g.totalKm += p.dist;
      }
    }
  }

  // Terceira passagem: paradas de setores adjacentes (se entregador tem espaço)
  for (const g of grupos_ent) {
    if (g.totalParadas >= g.limite || !naoAtribuidas.length) continue;
    const sobras = [...naoAtribuidas].sort((a, b) => {
      const compA = compatibilidadeRota(g.setor, a.setor);
      const compB = compatibilidadeRota(g.setor, b.setor);
      if (compB !== compA) return compB - compA;
      return a.dist - b.dist;
    });
    for (const p of sobras) {
      if (g.totalParadas >= g.limite) break;
      const idx = naoAtribuidas.indexOf(p);
      if (idx >= 0) {
        naoAtribuidas.splice(idx, 1);
        g.paradas.push(p);
        g.totalParadas++;
        g.totalKm += p.dist;
      }
    }
  }

  // Quarta passagem: paradas restantes → entregador com menos carga
  naoAtribuidas.forEach(p => {
    const comEspaco = [...grupos_ent].sort((a, b) => a.totalParadas - b.totalParadas);
    comEspaco[0].paradas.push(p);
    comEspaco[0].totalParadas++;
    comEspaco[0].totalKm += p.dist;
  });

  // PASSO 4: SUGESTÃO INTELIGENTE de pedidos extras
  // Para cada entregador, verifica se há pedidos do mesmo setor
  // que foram para outro entregador e poderiam estar nessa rota
  const sugestoesExtras = {};
  grupos_ent.forEach(g => {
    if (!g.setor || !g.paradas.length) return;
    // Verifica outros grupos se têm paradas do mesmo setor deste entregador
    const extras = [];
    grupos_ent.forEach(outro => {
      if (outro.entId === g.entId) return;
      outro.paradas.forEach(p => {
        if (p.setor === g.setor) {
          extras.push({ end: p.end, labels: p.labels, dist: p.dist });
        }
      });
    });
    if (extras.length > 0) {
      sugestoesExtras[g.entId] = extras;
    }
  });

  // PASSO 5: Montar resultado final
  const resultado = grupos_ent
    .filter(g => g.paradas.length > 0)
    .map(g => {
      // Ordena paradas por distância (mais próximo da loja primeiro)
      g.paradas.sort((a, b) => a.dist - b.dist);

      const setorNome = {
        'norte': '🔵 Norte', 'sul': '🔴 Sul', 'leste': '🟢 Leste',
        'oeste': '🟠 Oeste', 'centro': '🟡 Centro', 'sem_coords': '📍 Sem localização'
      };

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
            setor: parada.setor,
            _paradaLabels: parada.labels,
            _paradaEnd: parada.end,
            _paradaQtd: parada.qtdPeds,
            _paradaIndex: idx
          };
        })
      );

      const kmTotal = parseFloat(g.paradas.reduce((s, p) => s + p.dist, 0).toFixed(2));
      const valorTotal = parseFloat(pedidosFlat.reduce((s, p) => s + p.valor, 0).toFixed(2));
      const extras = sugestoesExtras[g.entId] || [];

      return {
        entId: g.entId,
        entNome: g.entNome,
        setor: g.setor,
        setorNome: setorNome[g.setor] || g.setor,
        descricao: setorNome[g.setor] || '📍 ' + g.paradas.length + ' parada(s)',
        pedidos: pedidosFlat,
        totalParadas: g.paradas.length,
        totalPedidos: pedidosFlat.length,
        kmTotal,
        valorTotal,
        // Sugestão inteligente: pedidos extras que poderiam ir nessa rota
        sugestaoExtras: extras
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
      .select('id,numero_pedido,cliente_nome,endereco_entrega,lat_entrega,lng_entrega,distancia_km')
      .eq('loja_id', lojaId)
      .eq('status', 'pendente');
    if (!pedidos || !pedidos.length) return res.status(200).json({ grupos: [], totalPedidos: 0, totalParadas: 0 });

    const entregadores = (distribuicao || []).map(([id, v]) => ({ id, nome: v.nome }));
    if (!entregadores.length) return res.status(400).json({ error: 'Nenhum entregador disponível' });

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
