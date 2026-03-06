import express from 'express';
import morgan from 'morgan';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(morgan('tiny'));

const APS_AUTH = 'https://developer.api.autodesk.com/authentication/v2/token';
const APS_PROJECT = 'https://developer.api.autodesk.com/project/v1';
const APS_DATA = 'https://developer.api.autodesk.com/data/v1';

/** 
 * Obtiene access_token usando REFRESH_TOKEN (3-legged).
 * Alternativa: implementar SSA más adelante si lo prefieres. 
 * Docs de auth/SSA: ver fuente.
 */
async function getAccessToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', process.env.APS_CLIENT_ID);
  params.append('client_secret', process.env.APS_CLIENT_SECRET);
  params.append('refresh_token', process.env.APS_REFRESH_TOKEN);
  // Opcional: limitar scopes al mínimo necesario
  params.append('scope', 'data:read data:write data:create account:read');

  const { data } = await axios.post(APS_AUTH, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return data.access_token;
}

/** GET /api/acc/projects - Lista proyectos ACC */
app.get('/api/acc/projects', async (req, res) => {
  try {
    const token = await getAccessToken();
    // 1) hubs (cuentas ACC)
    const { data: hubs } = await axios.get(`${APS_PROJECT}/hubs`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Filtra hubs ACC (extension.type == hubs:autodesk.acc:Account)
    const accHubs = (hubs.data || []).filter(
      h => h.attributes?.extension?.type?.includes('autodesk.acc')
    );

    // 2) proyectos por cada hub ACC
    const allProjects = [];
    for (const hub of accHubs) {
      const { data: projects } = await axios.get(
        `${APS_PROJECT}/hubs/${hub.id}/projects`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      for (const p of projects.data || []) {
        allProjects.push({
          id: p.id, // guardar tal cual para usar en data/v1
          name: p.attributes?.name || p.attributes?.displayName || 'Proyecto ACC'
        });
      }
    }
    res.json({ value: allProjects });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Error listing projects', detail: err?.response?.data || err.message });
  }
});

/** Helper: obtiene rootFolderId de un projectId ACC */
async function getRootFolderId(projectId, token) {
  const { data } = await axios.get(`${APS_PROJECT}/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return data?.data?.relationships?.rootFolder?.data?.id;
}

/** GET /api/acc/folders?projectId=...&parentId=... - Lista carpetas/contenidos */
app.get('/api/acc/folders', async (req, res) => {
  try {
    const { projectId, parentId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId requerido' });

    const token = await getAccessToken();
    const folderId = parentId || await getRootFolderId(projectId, token);

    // Contenido de la carpeta
    const { data } = await axios.get(
      `${APS_DATA}/projects/${projectId}/folders/${folderId}/contents`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Solo devolvemos carpetas; si quieres también items, ajústalo.
    const folders = (data?.data || [])
      .filter(i => i.type === 'folders')
      .map(f => ({
        id: f.id,
        name: f.attributes?.displayName || f.attributes?.name || 'Carpeta'
      }));

    res.json({ value: folders });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Error listing folders', detail: err?.response?.data || err.message });
  }
});

/**
 * POST /api/acc/upload
 * Query: projectId, folderId, fileName, downloadUrl (o bien spSiteId/spDriveId/spItemId si luego implementas Graph)
 * Body: { metadata?: { k:v } }
 * 
 * Estrategia: 
 *  - Descargamos el archivo desde downloadUrl (link de compartición de SharePoint/OneDrive con ?download=1).
 *  - Ejecutamos el flujo de subida a ACC:
 *    1) Create Storage
 *    2) Subir binario a URL firmada S3 (o POST form-data según respuesta)
 *    3) Completar upload (si aplica)
 *    4) Crear Item/Version en ACC (si el nombre ya existe en la carpeta, crear Version)
 *  Ver guía oficial APS para los pasos exactos y estructuras. 
 */
app.post('/api/acc/upload', async (req, res) => {
  try {
    const { projectId, folderId, fileName, downloadUrl } = req.query;
    const metadata = req.body || {};

    if (!projectId || !folderId || !fileName) {
      return res.status(400).json({ error: 'projectId, folderId y fileName son requeridos' });
    }

    if (!downloadUrl) {
      return res.status(400).json({
        error: 'Falta downloadUrl. Genera un enlace de compartición en el flujo de Power Automate (Create sharing link) y pásalo aquí con ?download=1.'
      });
    }

    const token = await getAccessToken();

    // 0) Descargar binario desde downloadUrl
    const fileResp = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const fileBuffer = Buffer.from(fileResp.data);

    // 1) Create Storage en ACC (Data Management)
    //    Ver estructura del payload en la guía oficial (type: "objects", relationships.target = folder).
    //    Fuente: "Upload a file" + blog .NET (puntos 3-8).
    const storagePayload = {
      data: {
        type: 'objects',
        attributes: { name: fileName },
        relationships: {
          target: { data: { type: 'folders', id: folderId } }
        }
      }
    };

    const { data: storageResp } = await axios.post(
      `${APS_DATA}/projects/${projectId}/storage`,
      storagePayload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' } }
    );

    // Según la versión del API, obtendrás parámetros de subida firmados (S3) o un objeto/urn de OSS.
    // En flujos recientes, se devuelve un "uploadParameters" o "signedUrl" para PUT a S3.
    // Adapta estas líneas a lo que devuelve tu respuesta (inspecciona storageResp).
    const storageData = storageResp?.data;
    // A) Caso URL S3 firmada (PUT):
    const signedUrl = storageData?.attributes?.uploadParameters?.url || storageData?.links?.upload;
    const formFields = storageData?.attributes?.uploadParameters?.fields;

    if (signedUrl && formFields) {
      // B) Caso POST tipo form-data a S3 (campos + file)
      // Muchos proyectos usan POST con form-data (campos + file).
      // Render/axios: para multipart con campos dinámicos usamos FormData.
      const FormData = (await import('form-data')).default;
      const fd = new FormData();
      // añade todos los fields requeridos por S3
      Object.entries(formFields).forEach(([k, v]) => fd.append(k, v));
      // y por último el archivo
      fd.append('file', fileBuffer, { filename: fileName });

      await axios.post(signedUrl, fd, { headers: fd.getHeaders() });

      // 2/3) En algunos flujos, "complete" es implícito al POST.
      // Si tu respuesta require "complete", llama al endpoint indicado en la doc.
      // (Revisa storageResp para ver si hay "completeUrl" o paso adicional).
    } else {
      // C) Caso PUT directo (menos común con ACC):
      // await axios.put(signedUrl, fileBuffer, { headers: { 'Content-Type': 'application/octet-stream' } });
    }

    // 4) Crear ítem o una nueva versión en ACC.
    //    Si el archivo ya existe en la carpeta (mismo nombre), debes crear una Version;
    //    si no existe, creas Item con Version inicial.
    //    Revisa la guía “Upload a file” para los payloads de items/versions.
    //    (Simplificado: aquí asumimos ítem nuevo).
    const itemPayload = {
      data: {
        type: 'items',
        attributes: {
          displayName: fileName,
          // Si tu carpeta tiene atributos obligatorios, debes incluirlos en extensiones/relationships correspondientes:
          // ver nota en doc "How Required Custom Attributes Influences Uploading..."
        },
        relationships: {
          tip: {
            data: { type: 'versions', id: '1' } // valor placeholder; ajustar según doc
          },
          parent: {
            data: { type: 'folders', id: folderId }
          }
        }
      },
      included: [
        {
          type: 'versions',
          id: '1',
          attributes: {
            name: fileName,
            extension: { type: 'versions:autodesk.bim360:File', version: '1.0' }
          },
          relationships: {
            storage: {
              data: {
                type: 'objects',
                id: storageResp?.data?.id
              }
            }
          }
        }
      ]
    };

    const { data: itemResp } = await axios.post(
      `${APS_DATA}/projects/${projectId}/items`,
      itemPayload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.api+json' } }
    );

    // Link de vuelta a ACC (si tu app quiere devolver webUrl, tendrás que construirlo o consultarlo)
    return res.json({
      versionUrn: itemResp?.data?.id || null,
      accWebUrl: null // opcional: construye enlace web si lo necesitas
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Error uploading to ACC', detail: err?.response?.data || err.message });
  }
});

/** 
 * ENDPOINTS AUXILIARES para obtener REFRESH_TOKEN una sola vez (opcional):
 * Render aloja tu backend, navegas a /auth/login, inicias sesión APS y /auth/callback te muestra el refresh_token para ponerlo en Environment.
 */
app.get('/auth/login', (req, res) => {
  const redirectUri = encodeURIComponent(process.env.APS_CALLBACK_URL);
  const scope = encodeURIComponent('data:read data:write data:create account:read');
  const url = `https://developer.api.autodesk.com/authentication/v2/authorize?response_type=code&client_id=${process.env.APS_CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}&prompt=select_account`;
});

app.get('/auth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', process.env.APS_CLIENT_ID);
    params.append('client_secret', process.env.APS_CLIENT_SECRET);
    params.append('code', code);
    params.append('redirect_uri', process.env.APS_CALLBACK_URL);

    const { data } = await axios.post(APS_AUTH, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // Muestra el refresh_token para que lo copies a Render Env Vars
    res.status(200).send(`
      <h3>Tokens obtenidos</h3>
      <pre>${JSON.stringify(data, null, 2)}</pre>
      <p>Copia <b>refresh_token</b> a APS_REFRESH_TOKEN en Render y redeploy.</p>
    `);
  } catch (e) {
    res.status(500).send(e?.response?.data || e.message);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
