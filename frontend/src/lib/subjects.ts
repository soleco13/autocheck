// Коды взяты из реальных control_sheets платформы (поле subject_code)
export const SUBJECTS = [
  { code: 'РЯ',   name: 'Русский язык',              color: '#d97706' },
  { code: 'Л',    name: 'Литература',                 color: '#db2777' },
  { code: 'ЛЧ',   name: 'Литературное чтение',        color: '#be185d' },
  { code: 'АЯ',   name: 'Английский язык',            color: '#7c3aed' },
  { code: 'МА',   name: 'Математика',                 color: '#2563eb' },
  { code: 'А',    name: 'Алгебра',                    color: '#1d4ed8' },
  { code: 'Г',    name: 'Геометрия',                  color: '#0d9488' },
  { code: 'ВИС',  name: 'Вероятность и статистика',   color: '#0891b2' },
  { code: 'ГЕО',  name: 'География',                  color: '#16a34a' },
  { code: 'ИС',   name: 'История',                    color: '#dc2626' },
  { code: 'О',    name: 'Обществознание',             color: '#ca8a04' },
  { code: 'ОДНКР',name: 'ОДНКНР',                     color: '#b45309' },
  { code: 'ОМ',   name: 'Окружающий мир',             color: '#15803d' },
  { code: 'Б',    name: 'Биология',                   color: '#166534' },
  { code: 'Ф',    name: 'Физика',                     color: '#0369a1' },
  { code: 'Х',    name: 'Химия',                      color: '#15803d' },
  { code: 'ИНФ',  name: 'Информатика',                color: '#6d28d9' },
  { code: 'ИЗО',  name: 'Изобразительное искусство',  color: '#9333ea' },
  { code: 'МУЗ',  name: 'Музыка',                     color: '#c026d3' },
  { code: 'ТЕХ',  name: 'Технология',                 color: '#475569' },
  { code: 'ФК',   name: 'Физическая культура',        color: '#0f766e' },
]

export function getSubjectColor(code: string) {
  return SUBJECTS.find(s => s.code === code)?.color ?? '#475467'
}

export function getSubjectName(code: string) {
  return SUBJECTS.find(s => s.code === code)?.name ?? code
}
