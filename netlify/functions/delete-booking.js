// Netlify Function: delete-booking
// Usada pela area de admin para excluir definitivamente um agendamento
// (feito por engano ou de teste) do arquivo bookings/index.json no
// repositorio GitHub. Tambem remove o arquivo de comprovante associado,
// se existir, para nao deixar lixo no repositorio.
//
// Mesmas variaveis de ambiente do save-booking.js / update-booking.js.

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
    const { id } = payload;

    if (!id) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'id do agendamento e obrigatorio.' }) };
    }

    const indexPath = 'bookings/index.json';
    const getRes = await githubRequest(`/repos/${owner}/${repo}/contents/${indexPath}?ref=${branch}`);
    if (getRes.status !== 200) {
      const errText = await getRes.text();
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Falha ao ler index.json', details: errText }) };
    }
    const fileData = await getRes.json();
    const sha = fileData.sha;
    const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8');
    let bookings = [];
    try { bookings = JSON.parse(decoded); } catch (e) { bookings = []; }

    const idx = bookings.findIndex(b => b.id === id);
    if (idx === -1) {
      return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'Agendamento nao encontrado (pode ja ter sido excluido).' }) };
    }

    const removido = bookings[idx];
    bookings.splice(idx, 1);

    const putRes = await githubRequest(`/repos/${owner}/${repo}/contents/${indexPath}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `Exclui agendamento ${id} (${removido.nome || 'sem nome'})`,
        content: b64EncodeUnicode(JSON.stringify(bookings, null, 2)),
        branch,
        sha
      })
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Falha ao gravar exclusao', details: errText }) };
    }

    // Tenta remover o arquivo de comprovante associado, se existir.
    // Isso e uma limpeza de melhor esforco: se falhar, nao impede a exclusao do pedido.
    if (removido.comprovantePath) {
      try {
        const fileRes = await githubRequest(`/repos/${owner}/${repo}/contents/${removido.comprovantePath}?ref=${branch}`);
        if (fileRes.status === 200) {
          const fileMeta = await fileRes.json();
          await githubRequest(`/repos/${owner}/${repo}/contents/${removido.comprovantePath}`, {
            method: 'DELETE',
            body: JSON.stringify({
              message: `Remove comprovante do agendamento excluido ${id}`,
              sha: fileMeta.sha,
              branch
            })
          });
        }
      } catch (e) {
        // silencioso: a exclusao do pedido ja foi concluida com sucesso.
      }
    }

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, removido: removido.id }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Erro interno', details: String(err && err.message || err) }) };
  }
};
