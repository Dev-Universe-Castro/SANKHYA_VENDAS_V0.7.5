import { redisCacheService } from './redis-cache-service';

export interface FiltroAnalise {
  dataInicio: string; // YYYY-MM-DD
  dataFim: string; // YYYY-MM-DD
}

export interface DadosAnalise {
  leads: any[];
  produtosLeads: any[];
  estagiosFunis: any[];
  funis: any[];
  atividades: any[];
  pedidos: any[];
  produtos: any[];
  clientes: any[];
  financeiro: any[];
  filtro: FiltroAnalise;
  timestamp: string;
}

const LOGIN_HEADERS = {
  'token': process.env.SANKHYA_TOKEN || "",
  'appkey': process.env.SANKHYA_APPKEY || "",
  'username': process.env.SANKHYA_USERNAME || "",
  'password': process.env.SANKHYA_PASSWORD || ""
};

const ENDPOINT_LOGIN = "https://api.sandbox.sankhya.com.br/login";
const URL_CONSULTA_SERVICO = "https://api.sandbox.sankhya.com.br/gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json";

let cachedToken: string | null = null;
let tokenPromise: Promise<string> | null = null;

async function obterToken(retryCount = 0): Promise<string> {
  // Se já tem token em cache, retornar imediatamente
  if (cachedToken) {
    return cachedToken;
  }

  // Se já está buscando token, aguardar a requisição em andamento
  if (tokenPromise) {
    return tokenPromise;
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000;

  // Criar promise para evitar requisições duplicadas
  tokenPromise = (async () => {
    try {
      console.log("🔐 Solicitando novo token de autenticação (analise-service)...");
      const axios = (await import('axios')).default;
      const resposta = await axios.post(ENDPOINT_LOGIN, {}, {
        headers: LOGIN_HEADERS,
        timeout: 30000 // Aumentado para 30s
      });

      const token = resposta.data.bearerToken || resposta.data.token;
      if (!token) {
        throw new Error("Token não encontrado na resposta de login.");
      }

      cachedToken = token;
      console.log("✅ Token obtido com sucesso (analise-service)");
      return token;
    } catch (erro: any) {
      // Retry para erros de timeout ou 500
      if ((erro.code === 'ECONNABORTED' || erro.response?.status === 500) && retryCount < MAX_RETRIES) {
        console.log(`🔄 Retry autenticação (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
        tokenPromise = null;
        return obterToken(retryCount + 1);
      }

      cachedToken = null;
      tokenPromise = null;
      
      const errorMsg = erro.code === 'ECONNABORTED' 
        ? 'Timeout ao conectar com Sankhya' 
        : erro.message;
      
      throw new Error(`Falha na autenticação Sankhya: ${errorMsg}`);
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

async function fazerRequisicaoAutenticada(fullUrl: string, data: any = {}, retryCount = 0) {
  const axios = (await import('axios')).default;
  const MAX_RETRIES = 2;
  const RETRY_DELAY = 1000;

  try {
    const token = await obterToken();

    const config = {
      method: 'post',
      url: fullUrl,
      data: data,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // Aumentado para 30s
    };

    const resposta = await axios(config);
    return resposta.data;
  } catch (erro: any) {
    // Token expirado - limpar cache e tentar novamente
    if (erro.response && (erro.response.status === 401 || erro.response.status === 403)) {
      cachedToken = null;
      
      if (retryCount < 1) {
        console.log("🔄 Token expirado, obtendo novo...");
        await new Promise(resolve => setTimeout(resolve, 500));
        return fazerRequisicaoAutenticada(fullUrl, data, retryCount + 1);
      }
      
      throw new Error("Sessão expirada. Tente novamente.");
    }

    // Retry para timeout ou erros de rede
    if ((erro.code === 'ECONNABORTED' || erro.response?.status >= 500) && retryCount < MAX_RETRIES) {
      console.log(`🔄 Retry requisição (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
      return fazerRequisicaoAutenticada(fullUrl, data, retryCount + 1);
    }

    throw erro;
  }
}

function formatarDataParaSankhya(dataISO: string): string {
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

function mapearEntidades(entities: any): any[] {
  if (!entities || !entities.entity) {
    return [];
  }

  const fieldNames = entities.metadata.fields.field.map((f: any) => f.name);
  const entityArray = Array.isArray(entities.entity) ? entities.entity : [entities.entity];

  return entityArray.map((rawEntity: any) => {
    const cleanObject: any = {};

    for (let i = 0; i < fieldNames.length; i++) {
      const fieldKey = `f${i}`;
      const fieldName = fieldNames[i];
      if (rawEntity[fieldKey]) {
        cleanObject[fieldName] = rawEntity[fieldKey].$;
      }
    }

    return cleanObject;
  });
}

export async function buscarDadosAnalise(
  filtro: FiltroAnalise,
  userId: number,
  isAdmin: boolean = false
): Promise<DadosAnalise> {

  const cacheKey = `analise:${userId}:${filtro.dataInicio}:${filtro.dataFim}`;

  // Verificar cache primeiro
  const cached = await redisCacheService.get<DadosAnalise>(cacheKey);
  if (cached) {
    console.log('✅ Retornando dados de análise do cache');
    return cached;
  }

  console.log('🔍 Buscando dados de análise da API...');

  const dataInicioSankhya = formatarDataParaSankhya(filtro.dataInicio);
  const dataFimSankhya = formatarDataParaSankhya(filtro.dataFim);

  try {
    // 1. Buscar Leads (filtrado por data de criação)
    let criteriaLeads = `DATA_CRIACAO BETWEEN '${dataInicioSankhya}' AND '${dataFimSankhya}' AND ATIVO = 'S'`;
    if (!isAdmin) {
      criteriaLeads += ` AND CODUSUARIO = ${userId}`;
    }

    const leadsPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_LEADS",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODLEAD, NOME, DESCRICAO, VALOR, CODESTAGIO, DATA_VENCIMENTO, TIPO_TAG, COR_TAG, CODPARC, CODFUNIL, CODUSUARIO, ATIVO, DATA_CRIACAO, DATA_ATUALIZACAO, STATUS_LEAD, MOTIVO_PERDA, DATA_CONCLUSAO"
            }
          },
          criteria: {
            expression: { $: criteriaLeads }
          }
        }
      }
    };

    // 2. Buscar Atividades (filtrado por data OU sem data)
    const atividadesPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_ADLEADSATIVIDADES",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODATIVIDADE, CODLEAD, TIPO, DESCRICAO, DATA_HORA, DATA_INICIO, DATA_FIM, CODUSUARIO, DADOS_COMPLEMENTARES, COR, ORDEM, ATIVO, STATUS"
            }
          },
          criteria: {
            expression: {
              $: `ATIVO = 'S' AND (DATA_HORA BETWEEN '${dataInicioSankhya}' AND '${dataFimSankhya}' OR DATA_HORA IS NULL)`
            }
          }
        }
      }
    };

    // 3. Buscar Funis
    const funisPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_FUNIS",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODFUNIL, NOME, DESCRICAO, COR, ATIVO, DATA_CRIACAO, DATA_ATUALIZACAO"
            }
          },
          criteria: {
            expression: { $: "ATIVO = 'S'" }
          }
        }
      }
    };

    // 4. Buscar Estágios de Funis
    const estagiosPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "AD_FUNISESTAGIOS",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "CODESTAGIO, CODFUNIL, NOME, ORDEM, COR, ATIVO"
            }
          },
          criteria: {
            expression: { $: "ATIVO = 'S'" }
          }
        }
      }
    };

    // Buscar dados SEQUENCIALMENTE para evitar sobrecarga na API
    console.log('📥 Buscando leads...');
    const leadsRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, leadsPayload).catch(err => {
      console.error('❌ Erro ao buscar leads:', err.message);
      return null;
    });

    console.log('📥 Buscando atividades...');
    const atividadesRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, atividadesPayload).catch(err => {
      console.error('❌ Erro ao buscar atividades:', err.message);
      return null;
    });

    console.log('📥 Buscando funis...');
    const funisRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, funisPayload).catch(err => {
      console.error('❌ Erro ao buscar funis:', err.message);
      return null;
    });

    console.log('📥 Buscando estágios...');
    const estagiosRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, estagiosPayload).catch(err => {
      console.error('❌ Erro ao buscar estágios:', err.message);
      return null;
    });

    console.log('📥 Buscando pedidos...');
    const pedidosPayload = {
      requestBody: {
        dataSet: {
          rootEntity: "CabecalhoNota",
          includePresentationFields: "S",
          offsetPage: null,
          disableRowsLimit: true,
          entity: {
            fieldset: {
              list: "NUNOTA, CODPARC, CODVEND, VLRNOTA, DTNEG"
            }
          },
          criteria: {
            expression: {
              $: `TIPMOV = 'P' AND DTNEG BETWEEN TO_DATE('${dataInicioSankhya}', 'DD/MM/YYYY') AND TO_DATE('${dataFimSankhya}', 'DD/MM/YYYY')`
            }
          },
          ordering: {
            expression: {
              $: "DTNEG DESC, NUNOTA DESC"
            }
          }
        }
      }
    };

    console.log('📤 Payload de pedidos:', JSON.stringify(pedidosPayload, null, 2));
    
    const pedidosRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, pedidosPayload).catch(err => {
      console.error('❌ Erro ao buscar pedidos:', err.message);
      return null;
    });

    console.log('📥 Buscando produtos...');
    const produtosRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, {
        requestBody: {
          dataSet: {
            rootEntity: "Produto",
            includePresentationFields: "N",
            offsetPage: null,
            disableRowsLimit: true,
            entity: {
              fieldset: {
                list: "CODPROD, DESCRPROD, ATIVO"
              }
            },
            criteria: {
              expression: { $: "ATIVO = 'S'" }
            }
          }
        }
      }).catch(err => {
        console.error('❌ Erro ao buscar produtos:', err.message);
        return null;
      });

    console.log('📥 Buscando clientes...');
    const clientesRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, {
        requestBody: {
          dataSet: {
            rootEntity: "Parceiro",
            includePresentationFields: "N",
            offsetPage: null,
            disableRowsLimit: true,
            entity: {
              fieldset: {
                list: "CODPARC, NOMEPARC, CGC_CPF, CLIENTE, ATIVO"
              }
            },
            criteria: {
              expression: { $: "CLIENTE = 'S' AND ATIVO = 'S'" }
            }
          }
        }
      }).catch(err => {
        console.error('❌ Erro ao buscar clientes:', err.message);
        return null;
      });

    console.log('📦 Respostas recebidas:', {
      leads: !!leadsRes?.responseBody?.entities,
      atividades: !!atividadesRes?.responseBody?.entities,
      funis: !!funisRes?.responseBody?.entities,
      estagios: !!estagiosRes?.responseBody?.entities,
      pedidos: !!pedidosRes?.responseBody?.entities,
      produtos: !!produtosRes?.responseBody?.entities,
      clientes: !!clientesRes?.responseBody?.entities
    });

    // Log detalhado da resposta de pedidos
    if (pedidosRes?.responseBody?.entities) {
      console.log('📊 Resposta de pedidos recebida:', {
        total: pedidosRes.responseBody.entities.total,
        hasEntity: !!pedidosRes.responseBody.entities.entity,
        metadata: pedidosRes.responseBody.entities.metadata ? 'presente' : 'ausente'
      });
      
      if (pedidosRes.responseBody.entities.entity) {
        console.log('📋 Estrutura do primeiro pedido:', JSON.stringify(
          Array.isArray(pedidosRes.responseBody.entities.entity) 
            ? pedidosRes.responseBody.entities.entity[0] 
            : pedidosRes.responseBody.entities.entity, 
          null, 
          2
        ));
      }
    } else {
      console.log('⚠️ Nenhuma resposta de pedidos ou responseBody vazio');
      console.log('📋 Resposta completa de pedidos:', JSON.stringify(pedidosRes, null, 2));
    }

    const leads = leadsRes?.responseBody?.entities ? mapearEntidades(leadsRes.responseBody.entities) : [];
    const atividades = atividadesRes?.responseBody?.entities ? mapearEntidades(atividadesRes.responseBody.entities) : [];
    const funis = funisRes?.responseBody?.entities ? mapearEntidades(funisRes.responseBody.entities) : [];
    const estagiosFunis = estagiosRes?.responseBody?.entities ? mapearEntidades(estagiosRes.responseBody.entities) : [];
    const pedidos = pedidosRes?.responseBody?.entities ? mapearEntidades(pedidosRes.responseBody.entities) : [];
    const produtos = produtosRes?.responseBody?.entities ? mapearEntidades(produtosRes.responseBody.entities) : [];
    const clientes = clientesRes?.responseBody?.entities ? mapearEntidades(clientesRes.responseBody.entities) : [];

    // Log dos dados mapeados
    console.log('📊 Pedidos mapeados:', pedidos.length > 0 ? pedidos.slice(0, 2) : 'NENHUM PEDIDO');

    console.log('📊 Dados mapeados:', {
      leads: leads.length,
      atividades: atividades.length,
      funis: funis.length,
      estagios: estagiosFunis.length,
      pedidos: pedidos.length,
      produtos: produtos.length,
      clientes: clientes.length
    });

    // 5. Buscar Produtos dos Leads encontrados
    let produtosLeads: any[] = [];
    if (leads.length > 0) {
      const codLeadsStr = leads.map(l => l.CODLEAD).join(',');
      const produtosLeadsPayload = {
        requestBody: {
          dataSet: {
            rootEntity: "AD_ADLEADSPRODUTOS",
            includePresentationFields: "S",
            offsetPage: null,
            disableRowsLimit: true,
            entity: {
              fieldset: {
                list: "CODITEM, CODLEAD, CODPROD, DESCRPROD, QUANTIDADE, VLRUNIT, VLRTOTAL, ATIVO, DATA_INCLUSAO"
              }
            },
            criteria: {
              expression: { $: `CODLEAD IN (${codLeadsStr}) AND ATIVO = 'S'` }
            }
          }
        }
      };

      const produtosLeadsRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, produtosLeadsPayload);
      produtosLeads = produtosLeadsRes?.responseBody?.entities ? mapearEntidades(produtosLeadsRes.responseBody.entities) : [];
    }

    // 6. Buscar Títulos a Receber (financeiro, filtrado por data de vencimento) - Removido conforme solicitado
    // const financeiroPayload = { ... };
    // const financeiroRes = await fazerRequisicaoAutenticada(URL_CONSULTA_SERVICO, financeiroPayload).catch(err => { ... });
    // const financeiro = financeiroRes?.responseBody?.entities ? mapearEntidades(financeiroRes.responseBody.entities) : [];

    const resultado: DadosAnalise = {
      leads,
      produtosLeads,
      estagiosFunis,
      funis,
      atividades,
      pedidos,
      produtos,
      clientes,
      financeiro: [], // Financeiro não é mais buscado
      filtro,
      timestamp: new Date().toISOString()
    };

    // Salvar no cache por 30 minutos
    await redisCacheService.set(cacheKey, resultado, 30 * 60);

    console.log('✅ Dados de análise salvos no cache');

    // O bloco de cálculo de métricas foi atualizado para remover o financeiro
    // e ajustar os logs e retornos de acordo.
    console.log(`📊 Dados completos carregados:`, {
      leads: resultado.leads.length,
      atividades: resultado.atividades.length,
      pedidos: resultado.pedidos.length,
      produtos: resultado.produtos.length,
      clientes: resultado.clientes.length,
      funis: resultado.funis.length,
      estagios: resultado.estagiosFunis.length
    });

    // Calcular métricas
    const valorTotalPedidos = resultado.pedidos.reduce((sum, p) => sum + (parseFloat(p.VLRNOTA) || 0), 0);

    return {
      leads: resultado.leads,
      produtosLeads: resultado.produtosLeads,
      atividades: resultado.atividades,
      pedidos: resultado.pedidos,
      produtos: resultado.produtos, // Incluir produtos buscados
      clientes: resultado.clientes,
      financeiro: [], // Financeiro não é mais buscado
      funis: resultado.funis,
      estagiosFunis: resultado.estagiosFunis,
      timestamp: new Date().toISOString(),
      filtro,
      // Métricas calculadas
      totalLeads: resultado.leads.length,
      totalAtividades: resultado.atividades.length,
      totalPedidos: resultado.pedidos.length,
      totalProdutos: resultado.produtos.length,
      totalClientes: resultado.clientes.length,
      totalFinanceiro: 0, // Não calculado
      valorTotalPedidos,
      valorTotalFinanceiro: 0, // Não calculado
      valorRecebido: 0, // Não calculado
      valorPendente: 0 // Não calculado
    };
  } catch (erro: any) {
    console.error('❌ Erro ao buscar dados de análise:', erro);
    throw erro;
  }
}