// GPA 公式只支持受限算术语法，避免把用户输入交给可执行函数或动态求值器。
// 这同时让主进程和渲染进程使用完全相同的解析规则。

export interface GpaGradeValues {
  credit: number;
  gradePoint: number;
  score?: number;
}

type TokenKind = "number" | "identifier" | "operator" | "left" | "right" | "eof";
interface Token {
  kind: TokenKind;
  text: string;
}

type Expression =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: keyof GpaGradeValues }
  | { kind: "unary"; operator: "+" | "-"; operand: Expression }
  | { kind: "binary"; operator: string; left: Expression; right: Expression }
  | { kind: "sum"; operand: Expression };

const MAX_FORMULA_LENGTH = 1000;
const MAX_TOKEN_COUNT = 256;
const NUMBER_PATTERN = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const VARIABLES = new Set<keyof GpaGradeValues>(["credit", "gradePoint", "score"]);

function tokenize(formula: string): Token[] {
  if (formula.length === 0 || formula.length > MAX_FORMULA_LENGTH)
    throw new Error("公式长度无效");
  const tokens: Token[] = [];
  let index = 0;
  while (index < formula.length) {
    const character = formula[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    const number = NUMBER_PATTERN.exec(formula.slice(index));
    if (number) {
      tokens.push({ kind: "number", text: number[0] });
      index += number[0].length;
    } else if (/[A-Za-z_]/.test(character)) {
      const start = index++;
      while (index < formula.length && /[A-Za-z0-9_]/.test(formula[index])) index++;
      tokens.push({ kind: "identifier", text: formula.slice(start, index) });
    } else if ("+-*/%^".includes(character)) {
      tokens.push({ kind: "operator", text: character });
      index++;
    } else if (character === "(") {
      tokens.push({ kind: "left", text: character });
      index++;
    } else if (character === ")") {
      tokens.push({ kind: "right", text: character });
      index++;
    } else {
      throw new Error(`公式包含不支持的字符：${character}`);
    }
    if (tokens.length > MAX_TOKEN_COUNT) throw new Error("公式过于复杂");
  }
  tokens.push({ kind: "eof", text: "" });
  return tokens;
}

class FormulaParser {
  private index = 0;
  private sumDepth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Expression {
    const result = this.parseAdditive();
    this.expect("eof");
    return result;
  }

  private parseAdditive(): Expression {
    let result = this.parseMultiplicative();
    while (this.match("+") || this.match("-")) {
      const operator = this.tokens[this.index - 1].text;
      result = { kind: "binary", operator, left: result, right: this.parseMultiplicative() };
    }
    return result;
  }

  private parseMultiplicative(): Expression {
    let result = this.parsePower();
    while (this.match("*") || this.match("/") || this.match("%")) {
      const operator = this.tokens[this.index - 1].text;
      result = { kind: "binary", operator, left: result, right: this.parsePower() };
    }
    return result;
  }

  private parsePower(): Expression {
    const left = this.parseUnary();
    if (!this.match("^")) return left;
    return { kind: "binary", operator: "^", left, right: this.parsePower() };
  }

  private parseUnary(): Expression {
    if (this.match("+") || this.match("-")) {
      const operator = this.tokens[this.index - 1].text as "+" | "-";
      return { kind: "unary", operator, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    if (token.kind === "number") {
      this.index++;
      const value = Number(token.text);
      if (!Number.isFinite(value)) throw new Error("公式数字无效");
      return { kind: "number", value };
    }
    if (token.kind === "identifier") return this.parseIdentifier();
    if (this.match("(")) {
      const result = this.parseAdditive();
      this.expect(")");
      return result;
    }
    throw new Error("公式缺少有效表达式");
  }

  private parseIdentifier(): Expression {
    const name = this.peek().text;
    this.index++;
    if (name === "SUM") {
      if (this.sumDepth > 0) throw new Error("SUM 不允许嵌套");
      this.expect("(");
      this.sumDepth++;
      const operand = this.parseAdditive();
      this.sumDepth--;
      this.expect(")");
      return { kind: "sum", operand };
    }
    if (!VARIABLES.has(name as keyof GpaGradeValues)) throw new Error(`公式变量不受支持：${name}`);
    return { kind: "variable", name: name as keyof GpaGradeValues };
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private match(text: string): boolean {
    if (this.peek().text !== text) return false;
    this.index++;
    return true;
  }

  private expect(text: string): void {
    if (text === "eof") {
      if (this.peek().kind !== "eof") throw new Error("公式末尾包含多余内容");
      return;
    }
    if (!this.match(text)) throw new Error(`公式缺少“${text}”`);
  }
}

function parseFormula(formula: string): Expression {
  return new FormulaParser(tokenize(formula.trim())).parse();
}

function finite(value: number, message: string): number {
  if (!Number.isFinite(value)) throw new Error(message);
  return value;
}

function valueOf(variable: keyof GpaGradeValues, grade: GpaGradeValues | null): number {
  if (!grade) throw new Error(`变量 ${variable} 必须位于 SUM(...) 内`);
  const value = grade[variable] ?? 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function evaluate(node: Expression, grade: GpaGradeValues | null, grades: readonly GpaGradeValues[]): number {
  if (node.kind === "number") return node.value;
  if (node.kind === "variable") return valueOf(node.name, grade);
  if (node.kind === "sum") {
    return grades.reduce((total, item) => total + evaluate(node.operand, item, grades), 0);
  }
  if (node.kind === "unary") {
    const value = evaluate(node.operand, grade, grades);
    return finite(node.operator === "-" ? -value : value, "公式结果不是有限数字");
  }
  const left = evaluate(node.left, grade, grades);
  const right = evaluate(node.right, grade, grades);
  if ((node.operator === "/" || node.operator === "%") && right === 0)
    throw new Error("公式不能除以零");
  const operations: Record<string, number> = {
    "+": left + right,
    "-": left - right,
    "*": left * right,
    "/": left / right,
    "%": left % right,
    "^": left ** right,
  };
  const result = operations[node.operator];
  return finite(result, "公式结果不是有限数字");
}

export function evaluateGpaFormula(formula: string, grades: readonly GpaGradeValues[]): number {
  if (grades.length === 0) return 0;
  const result = evaluate(parseFormula(formula), null, grades);
  return Math.round(finite(result, "公式结果不是有限数字") * 100) / 100;
}

export function validateGpaFormula(formula: string): { ok: boolean; error?: string } {
  try {
    evaluateGpaFormula(formula, [
      { credit: 4, gradePoint: 4, score: 90 },
      { credit: 3, gradePoint: 3, score: 80 },
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
