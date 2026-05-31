import { db } from '../db';

export interface ParsedTask {
  componentId: string;
  taskType: 'check_value' | 'open_answer' | 'matches' | 'input' | 'quiz' | 'fill_blanks';
  questionText: string;
  studentAnswer: string | null;
  studentAnswerStructured: any | null;
  correctAnswer: string | null;
  maxScore?: number;
}

// Decode HTML entity for formula attribute (may have &amp; etc.)
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// Preserve LaTeX formula as $...$ so the frontend can render it with KaTeX.
// Also strip font-size commands that don't affect meaning.
function latexPreserve(latex: string): string {
  return '$' + latex
    .replace(/\\(?:large|small|normalsize|tiny|huge|Huge)\s*/g, '')
    .replace(/\\q?quad\s*/g, '\\;')
    .replace(/\s+/g, ' ')
    .trim() + '$';
}

// For AI checker — plain text version (no $...$, no markup)
function latexToText(latex: string): string {
  return latex
    .replace(/\\(?:large|small|normalsize|tiny|huge|Huge)\s*/g, '')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\dfrac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
    .replace(/\\cdot/g, '·').replace(/\\times/g, '×').replace(/\\div/g, '÷')
    .replace(/\\pm/g, '±').replace(/\\mp/g, '∓')
    .replace(/\\leq?/g, '≤').replace(/\\geq?/g, '≥').replace(/\\neq?/g, '≠')
    .replace(/\\approx/g, '≈').replace(/\\equiv/g, '≡').replace(/\\infty/g, '∞')
    .replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\gamma/g, 'γ')
    .replace(/\\delta/g, 'δ').replace(/\\epsilon/g, 'ε').replace(/\\zeta/g, 'ζ')
    .replace(/\\eta/g, 'η').replace(/\\theta/g, 'θ').replace(/\\lambda/g, 'λ')
    .replace(/\\mu/g, 'μ').replace(/\\nu/g, 'ν').replace(/\\pi/g, 'π')
    .replace(/\\sigma/g, 'σ').replace(/\\tau/g, 'τ').replace(/\\phi/g, 'φ')
    .replace(/\\psi/g, 'ψ').replace(/\\omega/g, 'ω')
    .replace(/\\[Pp]hi/g, 'Φ').replace(/\\[Ss]igma/g, 'Σ').replace(/\\[Pp]i/g, 'Π')
    .replace(/\\[Oo]mega/g, 'Ω').replace(/\\[Gg]amma/g, 'Γ').replace(/\\[Dd]elta/g, 'Δ')
    .replace(/\^(\d)/g, '^$1').replace(/\^{([^}]+)}/g, '^($1)')
    .replace(/_(\d)/g, '_$1').replace(/_{([^}]+)}/g, '_($1)')
    .replace(/\\q?quad/g, ' ').replace(/\\[,;:!> ]/g, ' ')
    .replace(/\\\{/g, '{').replace(/\\\}/g, '}')
    .replace(/\s+/g, ' ').trim();
}

function stripHtml(html: string): string {
  // Extract edik-katex formulas — preserve as $...$ for frontend KaTeX rendering
  let result = html
    .replace(/<edik-katex[^>]*\sformula="([^"]*)"[^>]*>[\s\S]*?<\/edik-katex>/gi,
      (_, f) => ' ' + latexPreserve(decodeHtmlEntities(f.trim())) + ' ')
    .replace(/<edik-katex[^>]*\sformula="([^"]*)"[^>]*\/?>/gi,
      (_, f) => ' ' + latexPreserve(decodeHtmlEntities(f.trim())) + ' ');
  // Strip all remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  result = decodeHtmlEntities(result);
  return result.replace(/\s+/g, ' ').trim();
}

// Plain-text version for AI checker — strips all LaTeX markup to readable ASCII
function stripHtmlForAI(html: string): string {
  let result = html
    .replace(/<edik-katex[^>]*\sformula="([^"]*)"[^>]*>[\s\S]*?<\/edik-katex>/gi,
      (_, f) => ' ' + latexToText(decodeHtmlEntities(f.trim())) + ' ')
    .replace(/<edik-katex[^>]*\sformula="([^"]*)"[^>]*\/?>/gi,
      (_, f) => ' ' + latexToText(decodeHtmlEntities(f.trim())) + ' ');
  result = result.replace(/<[^>]+>/g, '');
  result = decodeHtmlEntities(result);
  return result.replace(/\s+/g, ' ').trim();
}

export interface SlideContext {
  problem: string;      // the actual task condition shown to the student
  instruction: string;  // format instruction ("Введи только число...")
  answerKey: string;    // teacher answer key extracted from criteria ("Ответы: 1530")
  criteria: string;     // grading criteria text (teacher-facing)
}

// Generic UI labels / button captions that carry no task meaning.
const GENERIC_LABELS = new Set([
  'проверить', 'пройти еще раз', 'пройти ещё раз', 'отправить', 'ответ', 'ответ:',
  'введи ответ', 'answer', 'answer:', 'я готов!', 'я готов', 'проверено', 'проверено ✔',
  'ожидаем..', 'ожидаем...', '',
]);

// Builds the full per-slide context for the AI checker. Splits text into:
//  - problem:    real task condition (root-level, non-generic, non-criteria)
//  - instruction: the "введи только число" style format hint
//  - answerKey/criteria: extracted from the "Критерии оценивания" note callouts
// mechObj (matching/quiz container) is skipped so option text never leaks into the problem.
function getSlideContext(slide: any, mechObj: any | null, CText: any): SlideContext {
  const problemParts: string[] = [];
  let instruction = '';
  let answerKey = '';
  const criteriaParts: string[] = [];

  // 1) Collect task text → problem / instruction. slide.objects is a FLAT list (it also
  //    contains the mechanic sub-parts: quiz_variant options, matches_what/with items,
  //    answer labels and buttons). Keep only plain text blocks and "*_question_text"
  //    prompts; drop option/button/answer-label parts so they never pollute the problem.
  for (const rootObj of slide.objects) {
    if (mechObj && (rootObj === mechObj || rootObj.id === mechObj.id)) continue;
    const tag: string = rootObj.tag || '';
    const isMechanicPart = /^(quiz_|matches_|check_value_|input_)/.test(tag);
    const isQuestionPrompt = /_question_text$/.test(tag);
    if (isMechanicPart && !isQuestionPrompt) continue;  // option / item / button / answer label
    const ct = rootObj.getComponent?.(CText);
    if (!ct?.text) continue;
    const text = stripHtml(ct.text);
    if (!text || GENERIC_LABELS.has(text.toLowerCase().trim())) continue;
    if (!/[\p{L}\p{N}]/u.test(text)) continue;          // pure symbol/emoji (e.g. "💡")
    if (text.match(/\[.+\|.+\]/)) continue;             // inline dropdown option text
    if (/^критерии оценивания/i.test(text)) continue;   // handled by the deep scan below
    if (/^комментарий для учителя/i.test(text)) continue; // teacher-only grading table
    if (/^введи в форму ответов/i.test(text)) { instruction = text; continue; }
    problemParts.push(text);
  }

  // 2) Deep scan for the "Критерии оценивания" note callouts (nested inside CNote),
  //    which also carry the answer key ("...Максимальный балл: 1 Ответы: 1530").
  for (const rootObj of slide.objects) {
    for (const obj of [rootObj, ...(rootObj.getDeepChildren?.() || [])]) {
      const ct = obj.getComponent?.(CText);
      if (!ct?.text) continue;
      const text = stripHtml(ct.text);
      if (!/критерии оценивания/i.test(text)) continue;
      criteriaParts.push(text);
      const m = text.match(/Ответы?\s*:\s*(.+)$/i);
      if (m && m[1].trim()) answerKey = m[1].trim();
    }
  }

  return {
    problem: [...new Set(problemParts)].join('\n'),
    instruction,
    answerKey,
    criteria: [...new Set(criteriaParts)].join('\n'),
  };
}

// Backwards-compatible helper: just the problem statement.
function getSlideQuestionText(slide: any, mechObj: any | null, CText: any): string {
  return getSlideContext(slide, mechObj, CText).problem;
}

// Parses ALL dropdown patterns from CText. Handles single and multi-dropdown objects.
// E.g. "Детство [есть только ед.ч.|есть ед.ч. и мн.ч.] , дети [есть ед.ч. и мн.ч.|...]"
// → [{questionText:"Детство", correctAnswer:"есть только ед.ч."}, {questionText:"дети", ...}]
function parseAllDropdownItems(html: string): Array<{ questionText: string; correctAnswer: string }> {
  const text = stripHtml(html);
  const items: Array<{ questionText: string; correctAnswer: string }> = [];
  const re = /([^\[]*?)\[([^|\]]+)\|([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const label = m[1].replace(/[,;:\s]+$/, '').replace(/^[,;:\s]+/, '').trim();
    items.push({ questionText: label, correctAnswer: m[2].trim() });
  }
  return items;
}

function getQuestionText(obj: any, CText: any): string {
  let cur = obj;
  for (let i = 0; i < 5; i++) {
    if (!cur) break;
    const comp = cur.getComponent(CText);
    if (comp?.text) {
      const t = stripHtml(comp.text);
      if (t) return t;
    }
    if (cur.parent && i > 0) {
      const siblings = cur.parent.getDeepChildren?.() || [];
      for (const sib of siblings) {
        if (sib === cur) continue;
        const sc = sib.getComponent?.(CText);
        if (sc?.text) {
          const t = stripHtml(sc.text);
          if (t) return t;
        }
      }
    }
    cur = cur.parent;
  }
  return '';
}

// Extracts mapping: AnswerInput slideObject id → list of accepted correct answers.
// The rules live in `<comp>.rulesChecker.rulesCache.val` as entries of the form
//   [answerInputId, { __meta:{t:16}, obj: answerInputId, values:{val:[...]} }]
// IMPORTANT: the checker component is NOT always type 11 — in current materials the
// rulesChecker sits on the input component itself (type 14/17). So scan ALL components,
// and read the AnswerInput id from `entry[1].obj` (the reliable link), keeping every
// accepted value (e.g. ["1530", "1530км", "1530 км"]).
function buildCorrectAnswerMap(baseState: any): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const map: Record<string, any> = baseState?.__meta?.map;
  if (!map) return result;

  for (const comp of Object.values(map)) {
    if (!comp || typeof comp !== 'object') continue;
    const rulesCache = (comp as any).rulesChecker?.rulesCache?.val;
    if (!Array.isArray(rulesCache)) continue;

    for (const entry of rulesCache) {
      const rule = entry?.[1];
      const answerInputId = (rule?.obj?.val ?? rule?.obj) ?? entry?.[0];
      const correctValues = rule?.values?.val ?? rule?.values;
      if (!answerInputId || !Array.isArray(correctValues)) continue;
      const vals = correctValues.map((v: any) => String(v)).filter((v: string) => v.trim() !== '');
      if (vals.length > 0) result.set(String(answerInputId), vals);
    }
  }

  return result;
}

// Builds mapping: CInput.id (type 14) → parent AnswerInput slideObject id
function buildCInputToAnswerInputMap(baseState: any): Map<string, string> {
  const result = new Map<string, string>();
  const map: Record<string, any> = baseState?.__meta?.map;
  if (!map) return result;

  for (const [id, comp] of Object.entries(map)) {
    if (!comp || typeof comp !== 'object') continue;
    const t = (comp as any).__meta?.t ?? (comp as any).t;
    if (t !== 2) continue; // only slideObjects

    const tag: string = (comp as any).tag || '';
    const name: string = (comp as any).name || '';
    if (tag !== 'check_value_answer_input' && name !== 'AnswerInput') continue;

    const components: string[] = (comp as any).components?.val || [];
    for (const childId of components) {
      const child = map[childId];
      if (!child) continue;
      const ct = (child as any).__meta?.t ?? (child as any).t;
      if (ct === 14 || ct === 17) { // CInput component (type varies by material version)
        result.set(String(childId), id);
      }
    }
  }

  return result;
}

export async function parseRawState(rawState: any): Promise<ParsedTask[]> {
  if (!rawState?.baseState) return [];

  const sharedVars: Record<string, any> = rawState.vars?.shared || {};
  const ownedVars: Record<string, any> = rawState.vars?.owned || {};
  // securedVars: server-evaluated results keyed as {compId}result → {isSolved, data}
  const securedVars: Record<string, any> = rawState.securedVars || {};

  const correctAnswerMap = buildCorrectAnswerMap(rawState.baseState);
  const cInputToAnswerInput = buildCInputToAnswerInputMap(rawState.baseState);

  try {
    // Use Function constructor to bypass TypeScript's import()->require() transformation
    // @itgenio/edik-core is ESM; dynamic require() fails for it
    const _dynImport = new Function('pkg', 'return import(pkg)');
    const { Parser, CInput, CText, CImage } = await _dynImport('@itgenio/edik-core');
    const material = await Parser.deserializeMaterial(rawState.baseState);
    const tasks: ParsedTask[] = [];

    // Build id→object map for text resolution (matching byWhat IDs, quiz variant IDs)
    const objById = new Map<string, any>();
    for (const slide of material.slides) {
      for (const rootObj of slide.objects) {
        objById.set(rootObj.id, rootObj);
        for (const child of rootObj.getDeepChildren()) {
          objById.set(child.id, child);
        }
      }
    }

    // Build lookup for dropdown-style sharedVars: key format is {±digits}_{objectId}
    // Skip "defoult" (platform placeholder for unanswered dropdowns)
    const dropdownBySuffix = new Map<string, string>();
    for (const [k, v] of Object.entries(sharedVars)) {
      if (k.endsWith('valueRuntime')) continue;
      if (typeof v !== 'string') continue;
      if (v === 'defoult' || v === 'default') continue; // unanswered
      if (/^-?\d+_/.test(k)) { // allow negative prefix (-849557633_...)
        dropdownBySuffix.set(k.slice(k.indexOf('_') + 1), v as string);
      }
    }
    const processedDropdownSuffixes = new Set<string>();
    // Deduplicate CInput — same component may appear multiple times in traversal
    const processedCInputIds = new Set<string>();

    for (let slideIdx = 0; slideIdx < material.slides.length; slideIdx++) {
      const slide = material.slides[slideIdx];
      const slideNum = slideIdx + 1; // 1-based slide number

      // Collect dropdown items found on this slide to group them
      const slideDropdowns: Array<{
        componentId: string;
        questionText: string;
        studentAnswer: string;
        correctAnswer: string | null;
      }> = [];

      for (const rootObj of slide.objects) {
        const allObjs: any[] = [rootObj, ...rootObj.getDeepChildren()];

        for (const obj of allObjs) {
          const inputComp = obj.getComponent(CInput);
          if (inputComp) {
            const inputId = inputComp.id;
            if (processedCInputIds.has(inputId)) continue; // skip duplicate occurrences
            processedCInputIds.add(inputId);
            // Correct answers: look up by the AnswerInput slideObject id (obj.id) — the key
            // used by rulesChecker — falling back to the CInput→AnswerInput resolution.
            const answerInputId = cInputToAnswerInput.get(inputId);
            const acceptable = correctAnswerMap.get(obj.id)
              ?? (answerInputId ? correctAnswerMap.get(answerInputId) : undefined)
              ?? null;
            const correctAnswer = acceptable && acceptable.length > 0 ? acceptable[0] : null;
            const hasCorrectAnswer = correctAnswer !== null;

            const answerVarKey = `${inputId}valueRuntime`;
            const rawAnswer = sharedVars[answerVarKey];
            const studentAnswer = rawAnswer !== undefined
              ? (typeof rawAnswer === 'string' ? rawAnswer : null)
              : null;

            {
              // Full slide context: problem condition, format instruction, answer key, criteria.
              const ctx = getSlideContext(slide, null, CText);
              // Per-input hint/label (e.g. "Введи значение числителя дроби из ответа").
              let hint = getQuestionText(obj, CText);
              if (hint && GENERIC_LABELS.has(hint.toLowerCase().trim())) hint = '';
              // Question text = slide problem + specific hint (when it adds information).
              let questionText = ctx.problem;
              if (hint && hint !== ctx.problem && !ctx.problem.includes(hint)) {
                questionText = ctx.problem ? `${ctx.problem}\n${hint}` : hint;
              }
              const hasImage = CImage && (obj.getComponent?.(CImage) || obj.parent?.getComponent?.(CImage));
              if (!questionText && hasImage) questionText = '[задание с изображением]';
              else if (hasImage) questionText = `${questionText} [есть изображение]`;

              tasks.push({
                componentId: inputId,
                taskType: hasCorrectAnswer ? 'check_value' : 'open_answer',
                questionText,
                studentAnswer,
                studentAnswerStructured: {
                  _slideNum: slideNum,
                  _slideProblem: ctx.problem || null,
                  _instruction: ctx.instruction || null,
                  _answerKey: ctx.answerKey || null,
                  _criteria: ctx.criteria || null,
                  _acceptableAnswers: acceptable || null,
                },
                correctAnswer,
              });
            }
            continue;
          }

          // Mechanic components: matching (byWhat state) and quiz (checkedVariants)
          for (const comp of obj.components) {
            // Matching mechanic
            const stateKey = `${comp.id}state`;
            const saved = ownedVars[stateKey];
            if (saved?.byWhat) {
              const secResult = securedVars[`${comp.id}result`];
              const byWhat: Record<string, string> = saved.byWhat;
              const pairs = Object.entries(byWhat).map(([leftId, rightId]) => {
                const lo = objById.get(leftId);
                const ro = objById.get(rightId);
                const lt = lo?.getComponent?.(CText)?.text ? stripHtml(lo.getComponent(CText).text) : leftId;
                const rt = ro?.getComponent?.(CText)?.text ? stripHtml(ro.getComponent(CText).text) : rightId;
                return `${lt} → ${rt}`;
              });
              const mCtx = getSlideContext(slide, obj, CText);
              tasks.push({
                componentId: comp.id,
                taskType: 'matches',
                questionText: mCtx.problem,
                studentAnswer: pairs.join('\n'),
                studentAnswerStructured: {
                  ...saved,
                  _isSolved: secResult?.isSolved ?? null,
                  _slideNum: slideNum,
                  _slideProblem: mCtx.problem || null,
                  _answerKey: mCtx.answerKey || null,
                  _criteria: mCtx.criteria || null,
                },
                correctAnswer: null,
              });
              break;
            }

            // Quiz / multi-select mechanic (checkedVariants in ownedVars)
            const checkedKey = `${comp.id}checkedVariants`;
            if (checkedKey in ownedVars) {
              const secResult = securedVars[`${comp.id}result`];
              const checked: string[] = ownedVars[checkedKey] || [];
              const correctVariants: any[] = comp.correctVariants || [];
              const correctIds = new Set(correctVariants.map((v: any) => v?.id ?? String(v)));
              const checkedSet = new Set(checked);

              // Get ALL options in display order from shuffledVariants
              const shuffledRaw = ownedVars[`${comp.id}shuffledVariants`];
              const shuffledItems: any[] = shuffledRaw
                ? (Object.values(shuffledRaw)[0] as any[] || []).sort((a: any, b: any) => a.index - b.index)
                : [];
              const allOptionIds = shuffledItems.length > 0
                ? shuffledItems.map((it: any) => it.id as string)
                : [...new Set([...checked, ...correctVariants.map((v: any) => v?.id ?? String(v))])];

              const allOptions = allOptionIds.map((id: string) => {
                const o = objById.get(id);
                const text = o?.getComponent?.(CText)?.text ? stripHtml(o.getComponent(CText).text) : id;
                return { id, text, isChecked: checkedSet.has(id), isCorrect: correctIds.has(id) };
              });

              const checkedTexts = allOptions.filter(o => o.isChecked).map(o => o.text);
              const correctTexts = allOptions.filter(o => o.isCorrect).map(o => o.text);

              const qCtx = getSlideContext(slide, obj, CText);
              tasks.push({
                componentId: comp.id,
                taskType: 'quiz',
                questionText: qCtx.problem,
                studentAnswer: checkedTexts.join(', '),
                studentAnswerStructured: {
                  allOptions,
                  _isSolved: secResult?.isSolved ?? null,
                  _slideNum: slideNum,
                  _slideProblem: qCtx.problem || null,
                  _answerKey: qCtx.answerKey || null,
                  _criteria: qCtx.criteria || null,
                },
                correctAnswer: correctTexts.join(', '),
              });
              break;
            }
          }

          // Dropdown: sharedVar keys in format {±digits}_{objectId[trailing_digit]}
          // One object may own MULTIPLE dropdowns — suffix = objId + position_index
          {
            const matching: Array<{suffix: string; value: string; idx: number}> = [];
            for (const [suffix, value] of dropdownBySuffix) {
              if (processedDropdownSuffixes.has(suffix)) continue;
              if (!suffix.startsWith(obj.id)) continue;
              const trail = suffix.slice(obj.id.length);
              const idx = trail === '' ? 0 : parseInt(trail, 10);
              if (!isNaN(idx)) matching.push({ suffix, value, idx });
            }
            if (matching.length > 0) {
              matching.sort((a, b) => a.idx - b.idx);
              for (const {suffix} of matching) processedDropdownSuffixes.add(suffix);
              const ct = obj.getComponent?.(CText);
              const allItems = ct?.text ? parseAllDropdownItems(ct.text) : [];
              for (const {value, idx} of matching) {
                // For multi-dropdown objects, use idx as position in CText.
                // For single-dropdown objects (one [..] pattern), always use item 0.
                const item = (allItems.length > 1 ? allItems[idx] : undefined) ?? allItems[0];
                slideDropdowns.push({
                  componentId: `${obj.id}_${idx}`,
                  questionText: item?.questionText || '',
                  studentAnswer: value,
                  correctAnswer: item?.correctAnswer || null,
                });
              }
            }
          }
        }
      }

      // Group all dropdowns on this slide into a single fill_blanks task
      if (slideDropdowns.length > 0) {
        const groupId = `fill_blanks_${slideDropdowns[0].componentId}`;
        const allCorrect = slideDropdowns.every(d => d.correctAnswer !== null && d.studentAnswer === d.correctAnswer);
        const someCorrect = slideDropdowns.some(d => d.correctAnswer !== null && d.studentAnswer === d.correctAnswer);
        const correctCount = slideDropdowns.filter(d => d.studentAnswer === d.correctAnswer).length;
        const fbCtx = getSlideContext(slide, null, CText);
        tasks.push({
          componentId: groupId,
          taskType: 'fill_blanks',
          questionText: fbCtx.problem,
          studentAnswer: slideDropdowns.map(d => `${d.questionText}: ${d.studentAnswer}`).join('\n'),
          studentAnswerStructured: {
            items: slideDropdowns,
            _isSolved: allCorrect ? true : someCorrect ? null : false,
            _slideNum: slideNum,
            _slideProblem: fbCtx.problem || null,
            _answerKey: fbCtx.answerKey || null,
            _criteria: fbCtx.criteria || null,
          },
          correctAnswer: slideDropdowns.map(d => `${d.questionText}: ${d.correctAnswer}`).join('\n'),
          maxScore: slideDropdowns.length,
        });
      }
    }

    return tasks;
  } catch (err) {
    console.warn('[answer-parser] deserializeMaterial failed, using raw fallback:', (err as Error).message);
    return parseRawStateFallback(rawState, correctAnswerMap, cInputToAnswerInput);
  }
}

function parseRawStateFallback(
  rawState: any,
  correctAnswerMap: Map<string, string[]>,
  cInputToAnswerInput: Map<string, string>
): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const meta = rawState.baseState?.__meta;
  if (!meta?.map) return tasks;

  const map: Record<string, any> = meta.map;
  const sharedVars: Record<string, any> = rawState.vars?.shared || {};
  const ownedVars: Record<string, any> = rawState.vars?.owned || {};
  const securedVars: Record<string, any> = rawState.securedVars || {};

  // Build text map: compId → text content (for CText type 4 components)
  const textMap = new Map<string, string>();
  for (const [id, comp] of Object.entries(map)) {
    if (!comp || typeof comp !== 'object') continue;
    const t = (comp as any).__meta?.t ?? (comp as any).t;
    if (t === 4) {
      const text = (comp as any).text?.val ?? (comp as any).text ?? '';
      if (text && typeof text === 'string') textMap.set(id, text);
    }
  }

  // Build parent map: compId → parentId
  const parentMap = new Map<string, string>();
  for (const [id, comp] of Object.entries(map)) {
    if (!comp || typeof comp !== 'object') continue;
    const components: string[] = (comp as any).components?.val || (comp as any).components || [];
    for (const childId of components) {
      parentMap.set(String(childId), id);
    }
  }

  // Find question text for a component by walking parent chain and looking for CText siblings
  function findQuestionTextForComp(compId: string): string {
    let cur = compId;
    for (let i = 0; i < 5; i++) {
      const parent = parentMap.get(cur);
      if (!parent) break;
      const parentComp = map[parent];
      if (!parentComp) break;
      const siblings: string[] = (parentComp as any).components?.val || (parentComp as any).components || [];
      for (const sib of siblings) {
        const t = textMap.get(String(sib));
        if (t) return t;
      }
      cur = parent;
    }
    return '';
  }

  // Strategy 1: scan sharedVars for any {componentId}valueRuntime keys (covers type 14 AND type 17+)
  for (const [key, value] of Object.entries(sharedVars)) {
    if (!key.endsWith('valueRuntime')) continue;
    const compId = key.slice(0, -'valueRuntime'.length);

    const answerInputId = cInputToAnswerInput.get(compId);
    const acceptable = (correctAnswerMap.get(compId) ?? (answerInputId ? correctAnswerMap.get(answerInputId) : undefined)) ?? null;
    const correctAnswer = acceptable && acceptable.length > 0 ? acceptable[0] : null;
    const questionText = findQuestionTextForComp(compId);

    tasks.push({
      componentId: compId,
      taskType: correctAnswer !== null ? 'check_value' : 'open_answer',
      questionText,
      studentAnswer: typeof value === 'string' ? value : null,
      studentAnswerStructured: null,
      correctAnswer,
    });
  }

  // Strategy 2: check_value input components with correct answers but no student answer yet
  for (const [id] of Object.entries(map)) {
    const comp = map[id];
    if (!comp || typeof comp !== 'object') continue;
    const t = (comp as any).__meta?.t ?? (comp as any).t;
    if (t !== 14 && t !== 17) continue;

    const answerInputId = cInputToAnswerInput.get(id);
    const acceptable = (correctAnswerMap.get(id) ?? (answerInputId ? correctAnswerMap.get(answerInputId) : undefined)) ?? null;
    const correctAnswer = acceptable && acceptable.length > 0 ? acceptable[0] : null;
    if (!correctAnswer) continue;

    const answerKey = `${id}valueRuntime`;
    if (answerKey in sharedVars) continue; // already added above

    tasks.push({
      componentId: id,
      taskType: 'check_value',
      questionText: '',
      studentAnswer: null,
      studentAnswerStructured: null,
      correctAnswer,
    });
  }

  // Strategy 3: matches (ownedVars {compId}state with byWhat)
  for (const [id, comp] of Object.entries(map)) {
    if (!comp || typeof comp !== 'object') continue;
    const t = (comp as any).__meta?.t ?? (comp as any).t;
    if (t === 14 || t === 11) continue;

    const stateKey = `${id}state`;
    const saved = ownedVars[stateKey];
    if (saved?.byWhat) {
      const secResult = securedVars[`${id}result`];
      tasks.push({
        componentId: id,
        taskType: 'matches',
        questionText: findQuestionTextForComp(id),
        studentAnswer: JSON.stringify(saved.byWhat),
        studentAnswerStructured: { ...saved, _isSolved: secResult?.isSolved ?? null },
        correctAnswer: null,
      });
    }
  }

  // Strategy 4: quiz/multi-select (ownedVars {compId}checkedVariants)
  for (const [key, value] of Object.entries(ownedVars)) {
    if (!key.endsWith('checkedVariants')) continue;
    if (!Array.isArray(value) || value.length === 0) continue;
    const compId = key.slice(0, -'checkedVariants'.length);
    if (!(compId + 'savedVariants' in ownedVars)) continue;
    // avoid duplicate with strategy 3
    if (compId + 'state' in ownedVars && (ownedVars[compId + 'state'] as any)?.byWhat) continue;

    const secResult = securedVars[`${compId}result`];
    tasks.push({
      componentId: compId,
      taskType: 'quiz',
      questionText: findQuestionTextForComp(compId),
      studentAnswer: value.join(', '),
      studentAnswerStructured: {
        checkedVariants: value,
        correctVariants: ownedVars[compId + 'savedVariants'] || [],
        _isSolved: secResult?.isSolved ?? null,
      },
      correctAnswer: null,
    });
  }

  // Strategy 5: dropdowns (sharedVars keys with format {±digits}_{objectId})
  for (const [k, v] of Object.entries(sharedVars)) {
    if (k.endsWith('valueRuntime')) continue;
    if (typeof v !== 'string') continue;
    if (v === 'defoult' || v === 'default') continue;
    if (!/^-?\d+_/.test(k)) continue;
    const compId = k.slice(k.indexOf('_') + 1);
    tasks.push({
      componentId: compId,
      taskType: 'fill_blanks',
      questionText: '',
      studentAnswer: v as string,
      studentAnswerStructured: null,
      correctAnswer: null,
    });
  }

  return tasks;
}

export async function saveAnswers(sessionId: string, rawState: any): Promise<void> {
  const sessionResult = await db.query(
    'SELECT control_sheet_id FROM student_sessions WHERE id = $1',
    [sessionId]
  );
  if (!sessionResult.rows[0]) throw new Error('Session not found');
  const controlSheetId = sessionResult.rows[0].control_sheet_id;

  const parsedTasks = await parseRawState(rawState);

  // Clear existing answers so re-checks produce fresh results
  await db.query('DELETE FROM answers WHERE session_id = $1', [sessionId]);

  // Upsert tasks (per-row for safe ON CONFLICT handling) and collect answer rows.
  const answerRows: Array<{ taskId: string; studentAnswer: string | null; structured: string | null }> = [];

  for (let i = 0; i < parsedTasks.length; i++) {
    const task = parsedTasks[i];
    const slideNum = task.studentAnswerStructured?._slideNum ?? null;
    const maxScore = task.maxScore ?? 1;

    const taskResult = await db.query(`
      INSERT INTO tasks (control_sheet_id, task_index, task_type, platform_component_id, question_text, reference_answer, slide_num, max_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (control_sheet_id, platform_component_id) DO UPDATE SET
        task_index = EXCLUDED.task_index,
        task_type = EXCLUDED.task_type,
        question_text = EXCLUDED.question_text,
        reference_answer = EXCLUDED.reference_answer,
        slide_num = EXCLUDED.slide_num,
        max_score = EXCLUDED.max_score
      RETURNING id
    `, [controlSheetId, i, task.taskType, task.componentId, task.questionText, task.correctAnswer, slideNum, maxScore]);

    let taskId: string;
    if (taskResult.rows[0]) {
      taskId = taskResult.rows[0].id;
    } else {
      const existing = await db.query(
        'SELECT id FROM tasks WHERE control_sheet_id = $1 AND platform_component_id = $2',
        [controlSheetId, task.componentId]
      );
      if (!existing.rows[0]) continue;
      taskId = existing.rows[0].id;
    }

    answerRows.push({
      taskId,
      studentAnswer: task.studentAnswer,
      structured: task.studentAnswerStructured ? JSON.stringify(task.studentAnswerStructured) : null,
    });
  }

  // Single multi-row INSERT for all answers (avoids N round-trips).
  if (answerRows.length > 0) {
    const values: any[] = [];
    const placeholders = answerRows.map((r, idx) => {
      const b = idx * 4;
      values.push(sessionId, r.taskId, r.studentAnswer, r.structured);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, 'pending')`;
    });
    await db.query(
      `INSERT INTO answers (session_id, task_id, student_answer, student_answer_structured, status)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
}
