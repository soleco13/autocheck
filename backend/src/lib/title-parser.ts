const SUBJECT_MAP: Record<string, string> = {
  'А': 'Алгебра',
  'Г': 'Геометрия',
  'АЯ': 'Английский язык',
  'Р': 'Русский язык',
  'Л': 'Литература',
  'Ф': 'Физика',
  'Х': 'Химия',
  'Б': 'Биология',
  'И': 'История',
  'О': 'Обществознание',
  'М': 'Математика',
};

export interface ParsedTitle {
  grade: number;
  subjectCode: string;
  subjectName: string;
  number: number;
  topic: string;
}

export function parseMaterialTitle(title: string): ParsedTitle | null {
  const match = title.match(/^(\d+)([А-ЯA-Z]+)(\d+)_(.+)$/);
  if (!match) return null;

  const [, gradeStr, subjectCode, numberStr, topic] = match;
  const grade = parseInt(gradeStr, 10);
  const number = parseInt(numberStr, 10);
  const subjectName = SUBJECT_MAP[subjectCode] || subjectCode;

  return { grade, subjectCode, subjectName, number, topic };
}
