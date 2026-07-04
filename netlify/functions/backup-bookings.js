// Netlify Scheduled Function: backup-bookings
// Roda automaticamente uma vez por dia (ver netlify.toml, secao
// [functions."backup-bookings"] com schedule = "@daily") e salva uma copia
// do arquivo bookings/index.json dentro de bookings/backups/AAAA-MM-DD.json
// no proprio repositorio GitHub, para que nunca percamos o historico de
// agendamentos mesmo se o arquivo principal for corrompido ou apagado
// por engano.
//
// Tambem apaga backups com mais de 60 dias para o repositorio nao crescer
// para sempre.
//
// Pode ser chamada manualmente (GET ou POST) a qualquer momento para forcar
// um backup imediato â nao depende exclusivamente do agendamento do Netlify.

const GITHUB_API = 'https://api.github.com';
const DIAS_PARA_MANTER_BACKUP = 60;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
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

function hojeISO() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

exports.handler = async function (event) {
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

    const indexPath = 'bookings/index.json';
    const getRes = await githubRequest(`/repos/${owner}/${repo}/contents/${indexPath}?ref=${branch}`);

    if (getRes.status === 404) {
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, skipped: 'index.json ainda nao existe, nada para fazer backup.' }) };
    }
    if (getRes.status !== 200) {
      const errText = await getRes.text();
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Falha ao ler index.json', details: errText }) };
    }

    const fileData = await getRes.json();
    const contentB64 = fileData.content;

    const backupPath = `bookings/backups/${hojeISO()}.json`;

    // Verifica se ja existe um backup de hoje, para saber se e criacao ou atualizacao (precisa do sha).
    let existingSha = null;
    const existingRes = await githubRequest(`/repos/${owner}/${repo}/contents/${backupPath}?ref=${branch}`);
    if (existingRes.status === 200) {
      const existingData = await existingRes.json();
      existingSha = existingData.sha;
      // Se o conteudo ja e identico ao atual, nao precisa recommitar.
      if (existingData.content && existingData.content.replace(/\n/g, '') === contentB64.replace(/\n/g, '')) {
        await limparBackupsAntigos(owner, repo, branch);
        return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, skipped: 'Backup de hoje ja esta atualizado.' }) };
      }
    }

    const putBody = {
      message: `Backup diario de agendamentos (${hojeISO()})`,
      content: contentB64,
      branch
    };
    if (existingSha) putBody.sha = existingSha;

    const putRes = await githubRequest(`/repos/${owner}/${repo}/contents/${backupPath}`, {
      method: 'PUT',
      body: JSON.stringify(putBody)
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'Falha ao gravar backup', details: errText }) };
    }

    const removidos = await limparBackupsAntigos(owner, repo, branch);

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, backupPath, backupsAntigosRemovidos: removidos }) };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Erro interno', details: String(err && err.message || err) }) };
  }
};

async function limparBackupsAntigos(owner, repo, branch) {
  try {
    const dirRes = await githubRequest(`/repos/${owner}/${repo}/contents/bookings/backups?ref=${branch}`);
    if (dirRes.status !== 200) return 0;
    const arquivos = await dirRes.json();
    if (!Array.isArray(arquivos)) return 0;

    const limite = new Date();
    limite.setUTCDate(limite.getUTCDate() - DIAS_PARA_MANTER_BACKUP);

    let removidos = 0;
    for (const arq of arquivos) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.json$/.exec(arq.name);
      if (!m) continue;
      const dataArquivo = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      if (dataArquivo < limite) {
        await githubRequest(`/repos/${owner}/${repo}/contents/bookings/backups/${arq.name}`, {
          method: 'DELETE',
          body: JSON.stringify({
            message: `Remove backup antigo (${arq.name})`,
            sha: arq.sha,
            branch
          })
        });
        removidos++;
      }
    }
    return removidos;
  } catch (e) {
    return 0;
  }
};
