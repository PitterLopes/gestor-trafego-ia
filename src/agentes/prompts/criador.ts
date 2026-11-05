/**
 * Prompts do Criador e do Verificador. O que a empresa pode afirmar está em AFIRMACOES_PERMITIDAS; o que nunca
 * pode, em PROIBIDO. Esses dois blocos são a "marca" do ponto de vista do anúncio: editar aqui muda o que o
 * sistema aceita escrever, sem mexer no resto.
 */
export { AFIRMACOES_PERMITIDAS, PROIBIDO } from "../../config/negocio.ts";
import { PRECO_LINHA } from "../../config/negocio.ts";

export const SISTEMA_CRIADOR = `Você escreve anúncios para a Meta (imagem 4:5 para o feed, ou vídeo com um chat animado na tela do produto, em 1:1 e 9:16) para a empresa descrita abaixo. Português do Brasil, direto, sem adjetivos vazios. O leitor é o cliente descrito no perfil da empresa.

Você recebe o ANÚNCIO BASE (o anúncio da conta que mais traz cadastro pelo menor custo: sua copy é uma variação dele), o ÂNGULO (o que variar, escolhido pelo analista), o perfil da empresa, a lista do que PODE ser afirmado e do que é PROIBIDO. Tudo o que você escrever tem que caber na lista do que pode; qualquer coisa fora dela é cortada por um verificador e o anúncio não sai.

Escreva em JSON, conforme o esquema:
- nome: nome interno do anúncio, curto, sem espaços no começo (ex.: "SetorCerto_4x5").
- titulo_imagem: a frase grande da imagem, até 75 caracteres, uma pergunta ou constatação sobre a dor; marque de 2 a 4 palavras entre [[ e ]] para destacar.
- promessa: duas linhas curtas (até 60 caracteres no total, separe com " | ") com o que a empresa ganha. Sem preço aqui.
- texto_primario: o texto do post, 2 a 4 linhas curtas, até 320 caracteres; termina com "${PRECO_LINHA}."
- headline: título do link, até 40 caracteres.
- descricao: até 30 caracteres.
- conversa: só quando o FORMATO for "video": de 5 a 8 mensagens (até 90 caracteres cada) dentro da TELA DE CHAT DO PRODUTO (o sistema da empresa, com lista de conversas, protocolo e setor; não é o WhatsApp). "cliente" é quem escreve, "atendente" é quem responde pelo sistema e "evento" é um aviso do sistema no meio da conversa (ex.: "Ana transferiu para Financeiro"; use no máximo 1). Mostre o problema de antes virando a solução que a empresa oferece (só o que está em PODE AFIRMAR). Nomes e situações fictícios, verossímeis, sem dados reais. Quando o formato for "imagem", devolva conversa como lista vazia.
- setor: só para vídeo: o setor da conversa (ex.: "Suporte"); atendente: o primeiro nome de quem responde (ex.: "Ana"); contato: o nome do cliente como aparece na lista de conversas (ex.: "Marcos Padaria"). Vazios no formato imagem.

Regras: uma ideia por anúncio; a dor antes da solução; nada do que está em PROIBIDO; preço só como está na lista; sem emoji na imagem.`;

export const ESQUEMA_COPY = {
  type: "object",
  additionalProperties: false,
  required: ["nome", "titulo_imagem", "promessa", "texto_primario", "headline", "descricao", "conversa", "setor", "atendente", "contato"],
  properties: {
    nome: { type: "string" },
    titulo_imagem: { type: "string" },
    promessa: { type: "string" },
    texto_primario: { type: "string" },
    headline: { type: "string" },
    descricao: { type: "string" },
    conversa: { type: "array", items: { type: "object", additionalProperties: false, required: ["de", "texto"], properties: { de: { type: "string", enum: ["cliente", "atendente", "evento"] }, texto: { type: "string" } } } },
    setor: { type: "string" },
    atendente: { type: "string" },
    contato: { type: "string" },
  },
} as const;

export const SISTEMA_VERIFICADOR = `Você revisa textos de anúncio de uma empresa de software antes de irem ao ar. Recebe a lista do que PODE ser afirmado, a lista do que é PROIBIDO e o texto. Para cada frase, decida se ela está dentro do permitido. Seja rigoroso com promessa de resultado, número inventado, "oficial", superlativo e preço diferente do permitido. Não reprove por estilo. Responda em JSON: problemas (lista de {trecho, motivo, viola}: SÓ frases que violam as listas, com viola = true; se listar uma frase que está em ordem, marque viola = false; lista vazia quando não há nada a reprovar) e aprovado (true exatamente quando nenhum item tem viola = true).`;

export const ESQUEMA_VERIFICACAO = {
  type: "object",
  additionalProperties: false,
  required: ["aprovado", "problemas"],
  properties: {
    aprovado: { type: "boolean" },
    problemas: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["trecho", "motivo", "viola"], properties: { trecho: { type: "string" }, motivo: { type: "string" }, viola: { type: "boolean", description: "true só se o trecho viola as listas; false se está em ordem" } } },
    },
  },
} as const;
