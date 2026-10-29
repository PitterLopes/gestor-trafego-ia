/**
 * TUDO o que é da sua empresa fica aqui. O instalador (CLAUDE.md) preenche este arquivo com você; o resto do
 * código não precisa mudar. Os textos vão para os prompts do Analista, do Estrategista, do Criador e do
 * verificador; os limites vão para o código que executa.
 */

/** Nome da empresa (aparece no alt da logo e nos nomes dos públicos). */
export const EMPRESA = "Sua Empresa";

/** Quem é a empresa, o que vende, quem é o cliente bom e o objetivo dos anúncios. 3 a 6 linhas. */
export const PERFIL_NEGOCIO = `A empresa vende [o quê] para [quem].
O cliente bom é [perfil que fica e paga]. [Perfil que costuma sair cedo], evitar.
Objetivo dos anúncios: trazer clientes que pagam e continuam pagando, não o maior número de cadastros.`;

/** O que os anúncios PODEM afirmar. Só o que você consegue provar. Uma linha por afirmação. */
export const AFIRMACOES_PERMITIDAS = `- [Benefício 1, como está no seu site]
- [Benefício 2]
- Preço: [como está na sua página de preços]
- [Condições do teste ou da garantia, se houver]
- Público: [quem você atende]`;

/** O que NUNCA pode aparecer. Além destas, o código barra promessa de resultado, "oficial", superlativo, urgência falsa e preço diferente. */
export const PROIBIDO = `- Garantia de resultado, de venda, de economia ou de prazo.
- Números de clientes, de avaliações ou de anos de mercado que não estejam provados.
- "Oficial", "aprovado" ou "parceiro" de qualquer plataforma.
- "Grátis" sem "teste" junto; "melhor", "número 1", "líder".
- Comparação com concorrente pelo nome. Urgência falsa.
- Inglês, gíria de marketing, emoji além de um por texto, CAIXA ALTA, ponto de exclamação repetido.`;

/** A linha de preço/chamada que fecha a imagem e o texto do anúncio. Exatamente como pode ser afirmada. */
export const PRECO_LINHA = "Teste grátis, sem cartão · R$ XX por mês";

/** Preço em reais que o verificador aceita (qualquer "R$ N" diferente é barrado). null = sem checagem de preço. */
export const PRECO_PERMITIDO: number | null = null;

/** Palavras que, acompanhadas de número, viram "número de clientes" e são barradas. */
export const PALAVRAS_CONTAGEM = ["clientes", "empresas", "usuários", "negócios"];

/** As conversas fictícias do template "tudo misturado" (celular do dono). Troque pelo seu contexto; são inventadas. */
export const TEMPLATE_CONVERSAS: Array<{ iniciais: string; cor: string; nome: string; setor: string; tom: "t1" | "t2" | "t3"; mensagem: string; hora: string; badge: string }> = [
  { iniciais: "CP", cor: "#E89B3C", nome: "Cliente · Padaria", setor: "Financeiro", tom: "t3", mensagem: "Pode mandar o boleto do mês?", hora: "09:12", badge: "3" },
  { iniciais: "CC", cor: "#4C7FD6", nome: "Cliente · Clínica", setor: "Suporte", tom: "t2", mensagem: "Alguém viu o meu contrato?", hora: "09:05", badge: "1" },
  { iniciais: "PO", cor: "#E0693F", nome: "Proposta · Oficina", setor: "Comercial", tom: "t1", mensagem: "Quanto fica o plano completo?", hora: "08:47", badge: "2" },
  { iniciais: "GF", cor: "#8A5BC9", nome: "Grupo · Entregas", setor: "Financeiro", tom: "t3", mensagem: "Anexei os comprovantes, confere?", hora: "08:30", badge: "12" },
  { iniciais: "CM", cor: "#3E9E8A", nome: "Cliente · Mercado", setor: "Suporte", tom: "t2", mensagem: "Ainda aguardo retorno…", hora: "ontem", badge: "5" },
  { iniciais: "EE", cor: "#8B979D", nome: "Ex-equipe · histórico antigo", setor: "", tom: "t2", mensagem: "Conversas de clientes no celular de quem saiu", hora: "seg", badge: "" },
];
/** Cabeçalho do "celular" no template. */
export const TEMPLATE_CABECALHO = { titulo: "WhatsApp · celular do dono", nota: "tudo misturado" };

/** Limites do executor. Mudar aqui é um commit revisado, não um prompt. */
export const LIMITES = {
  /** Soma do orçamento diário das campanhas ativas nunca passa disto (centavos). */
  TETO_DIARIO_CENTS: 30_000,
  /** Gasto em 7 dias sem nenhum cadastro que faz pausar. */
  PAUSAR_SEM_CADASTRO_CENTS: 15_000,
  /** Custo por cadastro acima de N× o da conta (28 dias) faz reduzir. */
  REDUZIR_FATOR: 2,
  REDUZIR_PCT: 20,
  AUMENTAR_MAX_PCT: 20,
  /** Dias entre mudanças na mesma campanha. */
  FREQUENCIA_DIAS: 7,
  ORCAMENTO_MIN_CENTS: 2_000,
  /** Gasto mínimo em 28 dias para "reduzir" ter base. */
  REDUZIR_MIN_GASTO_CENTS: 10_000,
};
