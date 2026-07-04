// Netlify Function: save-booking
// Recebe um novo agendamento do site publico e grava como arquivo JSON
// dentro do proprio repositorio GitHub (bookings/index.json), alem de
// salvar o comprovante como arquivo separado em bookings/uploads/.
//
// Requer variaveis de ambiente configuradas no Netlify:
//   GITHUB_TOKEN  -> Personal Access Token com escopo "repo" (ou "public_repo")
//   GITHUB_OWNER  -> dono do repositorio (ex: GanommaLab)
//   GITHUB_REPO   -> nome do repositorio (ex: agenda-ad-dunna)
//   GITHUB_BRANCH -> branch usada (ex: main) - opcional, default "main"

const GITHUB_API = 'https://api.github.com';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
}

async function githubRequest(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  return res;
}

function b64EncodeUnicode(str) {
  return Buffer.from(str, 'utf-8').toString('base64');
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    if (!process.env.GITHUB_TOKEN || !owner || !repo) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Variaveis de ambiente GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO nao configuradas no Netlify.' })
      };
    }

    const payload = JSON.parse(event.body || '{}');
    const {
      nome, telefone, data, horario, servico, valorServico,
      local, comprovanteBase64, comprovanteNome, comprovanteType
    } = payload;

    if (!nome || !telefone || !data || !horario || !servico || typeof valorServico !== 'number') {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Dados do agendamento incompletos.' }) };
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let comprovantePath = null;
    if (comprovanteBase64) {
      const raw = comprovanteBase64.includes(',') ? comprovanteBase64.split(',')[1] : comprovanteBase64;
      let ext = 'bin';
      if (comprovanteNome && comprovanteNome.includes('.')) {
        ext = comprovanteNome.split('.').pop().toLowerCase();
      } else if (comprovanteType === 'application/pdf') {
        ext = 'pdf';
      } else if (comprovanteType && comprovanteType.startsWith('image/')) {
        ext = comprovanteType.split('/')[1];
      }
      comprovantePath = `bookings/uploads/${id}.${ext}`;

      const uploadRes = await githubRequest(`/repos/${owner}/${repo}/contents/${comprovantePath}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Comprovante do agendamento ${id}`,
          content: raw,
          branch
        })
      });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Falha ao salvar comprovante', details: errText }) };
      }
    }

    // Le o index.json atual (se existir) para poder atualizar com o SHA correto
    const indexPath = 'bookings/index.json';
    let bookings = [];
    let sha = null;

    const getRes = await githubRequest(`/repos/${owner}/${repo}/contents/${indexPath}?ref=${branch}`);
    if (getRes.status === 200) {
      const fileData = await getRes.json();
      sha = fileData.sha;
      const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8');
      try { bookings = JSON.parse(decoded); } catch (e) { bookings = []; }
    } else if (getRes.status !== 404) {
      const errText = await getRes.text();
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Falha ao ler index.json', details: errText }) };
    }

    const novoAgendamento = {
      id,
      nome,
      telefone,
      data,
      horario,
      servico,
      valorServico,
      local: local || 'estabelecimento',
      custo: null,
      ganho: null,
      comprovantePath,
      status: 'novo',
      createdAt: new Date().toISOString()
    };

    bookings.push(novoAgendamento);

    const putBody = {
      message: `Novo agendamento: ${nome} (${data} ${horario})`,
      content: b64EncodeUnicode(JSON.stringify(bookings, null, 2)),
      branch
    };
    if (sha) putBody.sha = sha;

    const putRes = await githubRequest(`/repos/${owner}/${repo}/contents/${indexPath}`, {
      method: 'PUT',
      body: JSON.stringify(putBody)
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Falha ao gravar agendamento', details: errText }) };
    }

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, id }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Erro interno', details: String(err && err.message || err) }) };
  }
};
