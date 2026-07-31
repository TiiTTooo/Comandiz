// api/ler-cupom.js
//
// Proxy no servidor pra chamada à API do Gemini (Google) — a chave da API
// (GEMINI_API_KEY) só existe aqui, no ambiente da Vercel. Ela NÃO pode ir
// pro comandiz.html: esse arquivo é servido puro pro navegador de qualquer
// pessoa, então qualquer chave escrita ali fica visível a qualquer um que
// abrir "Ver código-fonte" ou a aba Rede do navegador.
//
// Configuração necessária (feita uma vez, direto no painel da Vercel):
// Settings → Environment Variables → GEMINI_API_KEY = <chave gerada em
// https://aistudio.google.com/apikey>. Depois de criar a variável, é
// preciso um novo deploy pra ela valer (redeploy do último commit resolve).

// gemini-2.5-flash foi trocado pra este modelo depois que uma chave nova
// (criada em ai.google.dev/apikey já em 2026) recebeu erro "no longer
// available to new users" — modelos antigos do Gemini vão sendo fechados
// pra chave nova mesmo continuando listados como GA na documentação, então
// se isso voltar a acontecer no futuro, é sinal de que esse aqui também
// saiu de linha e precisa trocar de novo pelo mais recente da família flash.
const MODELO = 'gemini-3.6-flash';

const SCHEMA_RESPOSTA = {
  type: 'OBJECT',
  properties: {
    fornecedor: { type: 'STRING', description: 'Nome do estabelecimento/loja impresso no cupom.' },
    valor: { type: 'NUMBER', description: 'Valor total pago, em reais, só o número (ex: 45.9).' },
    data: { type: 'STRING', description: 'Data da compra no formato AAAA-MM-DD. Se não achar, null.' },
    forma_pagamento: { type: 'STRING', enum: ['dinheiro', 'pix', 'debito', 'credito', 'desconhecido'] },
    descricao: { type: 'STRING', description: 'Resumo curto (até ~60 caracteres) dos itens comprados.' }
  },
  required: ['fornecedor', 'valor']
};

const PROMPT = 'Você está lendo a foto de um cupom fiscal ou nota de compra brasileira, de ' +
  'qualquer tipo de estabelecimento (mercado, farmácia, posto, loja, restaurante, distribuidor, ' +
  'etc.) — não é só de comércio de alimentação. É usada pra lançar uma despesa num sistema de ' +
  'gestão. Extraia ' +
  'os dados no formato JSON definido pelo schema. Se algum campo não aparecer claramente no ' +
  'cupom, retorne null pra ele (exceto valor e fornecedor, que são obrigatórios — faça sua ' +
  'melhor leitura mesmo que a imagem não esteja perfeita). Não invente forma de pagamento sem ' +
  'indicação clara no cupom; nesse caso use "desconhecido".';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, erro: 'Método não permitido.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, erro: 'GEMINI_API_KEY não configurada no servidor. Veja as instruções no topo deste arquivo.' });
    return;
  }

  const { imagemBase64, mimeType } = req.body || {};
  if (!imagemBase64 || typeof imagemBase64 !== 'string') {
    res.status(400).json({ ok: false, erro: 'Nenhuma imagem recebida.' });
    return;
  }
  // ~8MB de imagem original vira uns 11MB em base64 — o navegador já
  // comprime antes de mandar, então chegar perto disso indica algo errado.
  if (imagemBase64.length > 11000000) {
    res.status(400).json({ ok: false, erro: 'Imagem muito grande.' });
    return;
  }

  const corpo = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imagemBase64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: SCHEMA_RESPOSTA
    }
  };

  let respostaGemini;
  try {
    respostaGemini = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + MODELO + ':generateContent?key=' + apiKey,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }
    );
  } catch (err) {
    res.status(502).json({ ok: false, erro: 'Falha ao contatar o serviço de leitura: ' + err.message });
    return;
  }

  const dadosResposta = await respostaGemini.json().catch(() => null);
  if (!respostaGemini.ok || !dadosResposta) {
    const msgErro = (dadosResposta && dadosResposta.error && dadosResposta.error.message) || ('HTTP ' + respostaGemini.status);
    res.status(502).json({ ok: false, erro: 'Erro ao ler cupom: ' + msgErro });
    return;
  }

  const parteResposta = dadosResposta.candidates &&
    dadosResposta.candidates[0] &&
    dadosResposta.candidates[0].content &&
    dadosResposta.candidates[0].content.parts &&
    dadosResposta.candidates[0].content.parts[0];
  const texto = parteResposta && parteResposta.text;

  if (!texto) {
    res.status(502).json({ ok: false, erro: 'O cupom não pôde ser lido — tente uma foto mais nítida, com o valor total visível.' });
    return;
  }

  let extraido;
  try {
    extraido = JSON.parse(texto);
  } catch (err) {
    res.status(502).json({ ok: false, erro: 'Resposta do leitor em formato inesperado.' });
    return;
  }

  if (extraido.valor == null || isNaN(Number(extraido.valor))) {
    res.status(422).json({ ok: false, erro: 'Não consegui identificar o valor no cupom. Preencha manualmente.' });
    return;
  }

  res.status(200).json({
    ok: true,
    dados: {
      fornecedor: extraido.fornecedor || null,
      valor: Number(extraido.valor),
      data: /^\d{4}-\d{2}-\d{2}$/.test(extraido.data) ? extraido.data : null,
      forma_pagamento: ['dinheiro', 'pix', 'debito', 'credito'].includes(extraido.forma_pagamento) ? extraido.forma_pagamento : null,
      descricao: extraido.descricao || null
    }
  });
};
