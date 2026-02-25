// ============================================================
// 🚀 MONTA A ROTA AÍ - SERVIDOR COMPLETO (arquivo único)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== SUPABASE =====
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===== MIDDLEWARES =====
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== MIDDLEWARE AUTH =====
const autenticar = (req, res, next) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ erro: 'Token não fornecido' });
  try {
    req.usuario = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
};

// ===== HELPERS =====
const gerarCodigo = () => Math.floor(100000 + Math.random() * 900000).toString();
const previsaoEntrega = (min = 20) => { const d = new Date(); d.setMinutes(d.getMinutes() + min + 20); return d.toISOString(); };

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => res.json({ sistema: '🚀 Monta a Rota Aí', status: 'online', versao: '1.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });
    const { data: u, error } = await supabase.from('usuarios').select('*').eq('email', email.toLowerCase()).eq('status', 'ativo').single();
    if (error || !u) return res.status(401).json({ erro: 'Usuário não encontrado' });
    const ok = await bcrypt.compare(senha, u.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Senha incorreta' });
    await supabase.from('usuarios').update({ ultimo_login_at: new Date() }).eq('id', u.id);
    const token = jwt.sign({ id: u.id, email: u.email, papel: u.papel, loja_id: u.loja_id, entregador_id: u.entregador_id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, usuario: { id: u.id, nome: u.nome, email: u.email, papel: u.papel, loja_id: u.loja_id, entregador_id: u.entregador_id } });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/auth/cadastrar', async (req, res) => {
  try {
    const { nome, email, senha, papel, loja_id, entregador_id } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Dados obrigatórios faltando' });
    const senha_hash = await bcrypt.hash(senha, 10);
    const { data, error } = await supabase.from('usuarios').insert({ nome, email: email.toLowerCase(), senha_hash, papel: papel || 'loja', loja_id: loja_id || null, entregador_id: entregador_id || null }).select().single();
    if (error) return res.status(400).json({ erro: error.message });
    res.status(201).json({ mensagem: 'Usuário criado', id: data.id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================
// LOJAS
// ============================================================
app.get('/api/lojas', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('lojas').select('*').eq('status', 'ativo').order('nome');
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.get('/api/lojas/:id', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('lojas').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ erro: 'Loja não encontrada' });
  res.json(data);
});

app.post('/api/lojas', autenticar, async (req, res) => {
  try {
    const { nome, cnpj, telefone, endereco, bairro, cidade, cep, taxa_fixa, email, contato_nome } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const { data, error } = await supabase.from('lojas').insert({ nome, cnpj, telefone, endereco, bairro, cidade, cep, taxa_fixa: taxa_fixa || 4.50, email, contato_nome }).select().single();
    if (error) return res.status(400).json({ erro: error.message });
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/lojas/:id', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('lojas').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

// ============================================================
// ENTREGADORES
// ============================================================
app.get('/api/entregadores', autenticar, async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('entregadores').select('*').order('nome');
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.get('/api/entregadores/disponiveis', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('entregadores').select('id,nome,telefone,veiculo,avaliacao_media,lat_atual,lng_atual').eq('status', 'disponivel').order('avaliacao_media', { ascending: false });
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.get('/api/entregadores/:id', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('entregadores').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ erro: 'Entregador não encontrado' });
  res.json(data);
});

app.post('/api/entregadores', autenticar, async (req, res) => {
  try {
    const { nome, cpf, telefone, email, veiculo, placa, cnh, chave_pix } = req.body;
    if (!nome || !telefone) return res.status(400).json({ erro: 'Nome e telefone obrigatórios' });
    const { data, error } = await supabase.from('entregadores').insert({ nome, cpf, telefone, email, veiculo: veiculo || 'moto', placa, cnh, chave_pix }).select().single();
    if (error) return res.status(400).json({ erro: error.message });
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/entregadores/:id/gps', async (req, res) => {
  try {
    const { lat, lng, velocidade_kmh, precisao_m } = req.body;
    if (!lat || !lng) return res.status(400).json({ erro: 'Lat e Lng obrigatórios' });
    await supabase.from('entregadores').update({ lat_atual: lat, lng_atual: lng, ultimo_gps_at: new Date().toISOString() }).eq('id', req.params.id);
    await supabase.from('rastreamento_gps').insert({ entregador_id: req.params.id, lat, lng, velocidade_kmh, precisao_m });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/entregadores/:id/status', autenticar, async (req, res) => {
  const { status } = req.body;
  const validos = ['disponivel', 'em_rota', 'offline', 'bloqueado'];
  if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
  const { data, error } = await supabase.from('entregadores').update({ status }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

// ============================================================
// PEDIDOS
// ============================================================
app.get('/api/pedidos', autenticar, async (req, res) => {
  try {
    const { status, loja_id, entregador_id, data, limit = 50 } = req.query;
    let q = supabase.from('pedidos').select('*,lojas(nome),entregadores(nome,telefone)').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    if (loja_id) q = q.eq('loja_id', loja_id);
    if (entregador_id) q = q.eq('entregador_id', entregador_id);
    if (data) q = q.gte('created_at', `${data}T00:00:00`).lte('created_at', `${data}T23:59:59`);
    if (req.usuario.papel === 'loja') q = q.eq('loja_id', req.usuario.loja_id);
    const { data: pedidos, error } = await q;
    if (error) return res.status(400).json({ erro: error.message });
    res.json(pedidos);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/pedidos/alertas/atraso', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('pedidos').select('*,entregadores(nome,telefone),lojas(nome)').in('status', ['pendente','aceito','coletado','em_rota']).lt('previsao_entrega', new Date().toISOString());
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data || []);
});

app.get('/api/pedidos/:id', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('pedidos').select('*,lojas(nome,telefone,endereco),entregadores(nome,telefone,lat_atual,lng_atual)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ erro: 'Pedido não encontrado' });
  res.json(data);
});

app.post('/api/pedidos', autenticar, async (req, res) => {
  try {
    const { loja_id, cliente_nome, cliente_telefone, cliente_endereco, cliente_bairro, cliente_cidade, cliente_cep, cliente_complemento, itens, valor_pedido, forma_pagamento, troco_para, tempo_preparo_min, observacoes, origem } = req.body;
    if (!cliente_endereco) return res.status(400).json({ erro: 'Endereço do cliente obrigatório' });
    const codigo_confirmacao = gerarCodigo();
    const { data, error } = await supabase.from('pedidos').insert({
      loja_id: loja_id || req.usuario.loja_id, cliente_nome, cliente_telefone, cliente_endereco,
      cliente_bairro, cliente_cidade, cliente_cep, cliente_complemento, itens, valor_pedido,
      forma_pagamento, troco_para, taxa_plataforma: 4.50, codigo_confirmacao,
      previsao_entrega: previsaoEntrega(tempo_preparo_min || 20),
      tempo_preparo_min: tempo_preparo_min || 20, observacoes, origem: origem || 'manual', status: 'pendente'
    }).select().single();
    if (error) return res.status(400).json({ erro: error.message });
    res.status(201).json({ ...data, mensagem: '✅ Pedido criado!', codigo_confirmacao });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/pedidos/:id/status', autenticar, async (req, res) => {
  try {
    const { status } = req.body;
    const validos = ['pendente','aceito','coletado','em_rota','entregue','cancelado','problema'];
    if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    const campos = { status };
    const agora = new Date().toISOString();
    if (status === 'aceito') campos.aceito_em = agora;
    if (status === 'coletado') campos.coletado_em = agora;
    if (status === 'entregue') campos.entregue_em = agora;
    if (status === 'cancelado') campos.cancelado_em = agora;
    const { data, error } = await supabase.from('pedidos').update(campos).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ erro: error.message });
    res.json({ mensagem: `Status: ${status}`, pedido: data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/pedidos/:id/confirmar', async (req, res) => {
  try {
    const { codigo } = req.body;
    const { data: pedido, error } = await supabase.from('pedidos').select('*').eq('id', req.params.id).single();
    if (error || !pedido) return res.status(404).json({ erro: 'Pedido não encontrado' });
    if (pedido.codigo_confirmacao !== codigo) return res.status(400).json({ erro: '❌ Código inválido' });
    if (pedido.confirmado_em) return res.status(400).json({ erro: 'Pedido já confirmado' });
    await supabase.from('pedidos').update({ confirmado_em: new Date().toISOString(), status: 'entregue' }).eq('id', req.params.id);
    if (pedido.entregador_id) {
      const { data: ent } = await supabase.from('entregadores').select('total_entregas,saldo').eq('id', pedido.entregador_id).single();
      if (ent) await supabase.from('entregadores').update({ total_entregas: (ent.total_entregas || 0) + 1, saldo: (ent.saldo || 0) + 4.50 }).eq('id', pedido.entregador_id);
    }
    res.json({ mensagem: '✅ Entrega confirmada!' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================
// ROTAS
// ============================================================
app.post('/api/rotas/montar', autenticar, async (req, res) => {
  try {
    const { entregador_id, pedidos_ids, loja_endereco } = req.body;
    if (!entregador_id || !pedidos_ids?.length) return res.status(400).json({ erro: 'entregador_id e pedidos_ids obrigatórios' });
    const { data: pedidos, error } = await supabase.from('pedidos').select('*').in('id', pedidos_ids);
    if (error) return res.status(400).json({ erro: error.message });
    const destinos = pedidos.map(p => encodeURIComponent(p.cliente_endereco));
    const origem = encodeURIComponent(loja_endereco || 'origem');
    const linkGoogleMaps = `https://www.google.com/maps/dir/${origem}/${destinos.join('/')}`;
    const linkWaze = `https://waze.com/ul?q=${destinos[0]}&navigate=yes`;
    const { data: rota, error: erroRota } = await supabase.from('rotas').insert({
      entregador_id, pedidos_ids: pedidos.map(p => p.id), total_pedidos: pedidos.length,
      link_google_maps: linkGoogleMaps, link_waze: linkWaze, status: 'pendente',
      valor_total_taxas: pedidos.length * 4.50
    }).select().single();
    if (erroRota) return res.status(400).json({ erro: erroRota.message });
    await supabase.from('pedidos').update({ status: 'aceito', aceito_em: new Date().toISOString() }).in('id', pedidos_ids);
    await supabase.from('entregadores').update({ status: 'em_rota' }).eq('id', entregador_id);
    res.status(201).json({
      rota, link_google_maps: linkGoogleMaps, link_waze: linkWaze,
      mensagem: `✅ Rota com ${pedidos.length} entrega(s) montada!`,
      pedidos: pedidos.map((p, i) => ({ ordem: i + 1, id: p.id, cliente: p.cliente_nome, endereco: p.cliente_endereco, codigo_confirmacao: p.codigo_confirmacao }))
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/rotas', autenticar, async (req, res) => {
  const { status, entregador_id } = req.query;
  let q = supabase.from('rotas').select('*,entregadores(nome,telefone),lojas(nome)').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  if (entregador_id) q = q.eq('entregador_id', entregador_id);
  const { data, error } = await q;
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.patch('/api/rotas/:id/iniciar', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('rotas').update({ status: 'em_andamento', iniciada_em: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ mensagem: '🛵 Rota iniciada!', rota: data });
});

app.patch('/api/rotas/:id/concluir', autenticar, async (req, res) => {
  try {
    const { data: rota } = await supabase.from('rotas').select('*').eq('id', req.params.id).single();
    await supabase.from('rotas').update({ status: 'concluida', concluida_em: new Date().toISOString() }).eq('id', req.params.id);
    await supabase.from('entregadores').update({ status: 'disponivel' }).eq('id', rota.entregador_id);
    res.json({ mensagem: '✅ Rota concluída!' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================
// PAGAMENTOS
// ============================================================
app.get('/api/pagamentos', autenticar, async (req, res) => {
  const { loja_id, entregador_id, status } = req.query;
  let q = supabase.from('pagamentos').select('*,lojas(nome),entregadores(nome)').order('created_at', { ascending: false });
  if (loja_id) q = q.eq('loja_id', loja_id);
  if (entregador_id) q = q.eq('entregador_id', entregador_id);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

app.post('/api/pagamentos/gerar-semanal', autenticar, async (req, res) => {
  try {
    const { loja_id, periodo_inicio, periodo_fim } = req.body;
    const { data: pedidos } = await supabase.from('pedidos').select('id,taxa_plataforma').eq('loja_id', loja_id).eq('status', 'entregue').gte('created_at', `${periodo_inicio}T00:00:00`).lte('created_at', `${periodo_fim}T23:59:59`);
    const total_entregas = pedidos?.length || 0;
    const valor_bruto = pedidos?.reduce((s, p) => s + (p.taxa_plataforma || 4.50), 0) || 0;
    const { data, error } = await supabase.from('pagamentos').insert({ tipo: 'loja_para_plataforma', loja_id, periodo_inicio, periodo_fim, total_entregas, valor_bruto, valor_liquido: valor_bruto, status: 'pendente' }).select().single();
    if (error) return res.status(400).json({ erro: error.message });
    res.status(201).json({ ...data, mensagem: `💰 ${total_entregas} entregas = R$ ${valor_bruto.toFixed(2)}` });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/api/pagamentos/:id/pagar', autenticar, async (req, res) => {
  const { metodo_pagamento, comprovante_url } = req.body;
  const { data, error } = await supabase.from('pagamentos').update({ status: 'pago', metodo_pagamento, comprovante_url, pago_em: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ mensagem: '✅ Pagamento registrado!', pagamento: data });
});

// ============================================================
// ANALYTICS
// ============================================================
app.get('/api/analytics/resumo/:loja_id', autenticar, async (req, res) => {
  try {
    const { loja_id } = req.params;
    const hoje = new Date().toISOString().split('T')[0];
    const inicioMes = hoje.substring(0, 7) + '-01';
    const { data: pedidosHoje } = await supabase.from('pedidos').select('id,valor_pedido,taxa_plataforma,cliente_bairro').eq('loja_id', loja_id).eq('status', 'entregue').gte('created_at', `${hoje}T00:00:00`);
    const { data: pedidosMes } = await supabase.from('pedidos').select('id,taxa_plataforma').eq('loja_id', loja_id).eq('status', 'entregue').gte('created_at', `${inicioMes}T00:00:00`);
    const bairros = {};
    pedidosHoje?.forEach(p => { if (p.cliente_bairro) bairros[p.cliente_bairro] = (bairros[p.cliente_bairro] || 0) + 1; });
    const topBairros = Object.entries(bairros).sort((a, b) => b[1] - a[1]).slice(0, 5);
    res.json({
      hoje: { total_pedidos: pedidosHoje?.length || 0, receita_taxa: pedidosHoje?.reduce((s, p) => s + (p.taxa_plataforma || 4.50), 0) || 0 },
      mes: { total_pedidos: pedidosMes?.length || 0, receita_taxa: pedidosMes?.reduce((s, p) => s + (p.taxa_plataforma || 4.50), 0) || 0 },
      top_bairros: topBairros.map(([bairro, total]) => ({ bairro, total })),
      sugestao: topBairros.length > 0 ? `🎯 Foque marketing no bairro ${topBairros[0][0]}` : 'Sem dados ainda'
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================
// OCR
// ============================================================
app.post('/api/ocr/processar', autenticar, async (req, res) => {
  try {
    const { foto_url, loja_id, texto_bruto } = req.body;
    const txt = texto_bruto || '';
    const cliente_telefone = (txt.match(/\(?\d{2}\)?\s?\d{4,5}[-\s]?\d{4}/) || [])[0] || null;
    const cliente_cep = (txt.match(/\d{5}-?\d{3}/) || [])[0] || null;
    const matchValor = txt.match(/R\$\s?(\d+[.,]\d{2})/);
    const valor_pedido = matchValor ? parseFloat(matchValor[1].replace(',', '.')) : null;
    const { data, error } = await supabase.from('comandas_ocr').insert({ loja_id, foto_url: foto_url || 'pendente', texto_bruto, cliente_telefone, cliente_cep, valor_pedido, confianca_ocr: 0.75, confirmado: false }).select().single();
    if (error) return res.status(400).json({ erro: error.message });
    res.json({ ...data, mensagem: '📸 Comanda processada! Revise os dados.' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ============================================================
// RASTREAMENTO
// ============================================================
app.get('/api/rastreamento/entregador/:id', autenticar, async (req, res) => {
  const { data, error } = await supabase.from('rastreamento_gps').select('lat,lng,created_at,velocidade_kmh').eq('entregador_id', req.params.id).order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(400).json({ erro: error.message });
  res.json(data);
});

// ===== 404 e ERROS =====
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));
app.use((err, req, res, next) => res.status(500).json({ erro: err.message }));

// ===== INICIAR =====
app.listen(PORT, () => {
  console.log(`✅ Monta a Rota Aí rodando na porta ${PORT}`);
});

module.exports = app;
