export type ChaoxingCommand =
  | { kind: 'menu' | 'bind' | 'confirm_help' | 'status' | 'unbind' | 'courses' | 'todo' | 'works' | 'exams' | 'sign_quick' | 'sign_list' | 'sign_stop' | 'job_status' | 'study_status' | 'study_stop' | 'answer_stop' | 'wrong_answers' }
  | { kind: 'confirm'; code: string }
  | { kind: 'chapters' | 'sign_watch' | 'study_start' | 'answer_start'; courseQuery: string }
  | { kind: 'sign_execute'; activityId: string; code?: string }
  | { kind: 'answer_supplement'; jobId: number; questionPosition: number; answer: string }
  | { kind: 'answer_save' | 'answer_submit'; jobId: number };

export function parseChaoxingCommand(text: string): ChaoxingCommand | null {
  if (text === '学习通') return { kind: 'menu' };
  if (text === '学习通绑定') return { kind: 'bind' };
  if (/^学习通确认\s*$/u.test(text)) return { kind: 'confirm_help' };
  const confirm = text.match(/^学习通确认\s+(\d{6})$/u);
  if (confirm?.[1]) return { kind: 'confirm', code: confirm[1] };
  if (text === '学习通状态') return { kind: 'status' };
  if (text === '学习通解绑') return { kind: 'unbind' };
  if (text === '学习通课程') return { kind: 'courses' };
  const chapters = text.match(/^学习通章节\s+(.+)$/u);
  if (chapters?.[1]) return { kind: 'chapters', courseQuery: chapters[1].trim() };
  if (text === '学习通待办') return { kind: 'todo' };
  if (text === '学习通作业') return { kind: 'works' };
  if (text === '学习通考试') return { kind: 'exams' };
  if (text === '学习通签到') return { kind: 'sign_quick' };
  if (text === '学习通签到状态') return { kind: 'sign_list' };
  if (text === '学习通签到监听') return { kind: 'sign_watch', courseQuery: '' };
  const watch = text.match(/^学习通签到监听\s+(.+)$/u);
  if (watch?.[1]) return { kind: 'sign_watch', courseQuery: watch[1].trim() };
  if (text === '学习通停止签到') return { kind: 'sign_stop' };
  const sign = text.match(/^学习通签到\s+(\S+)(?:\s+(.+))?$/u);
  if (sign?.[1]) return { kind: 'sign_execute', activityId: sign[1], code: sign[2]?.trim() };
  const study = text.match(/^学习通刷课\s+(.+)$/u);
  if (study?.[1] && study[1] !== '状态') return { kind: 'study_start', courseQuery: study[1].trim() };
  if (text === '学习通刷课状态') return { kind: 'study_status' };
  if (text === '学习通任务状态') return { kind: 'job_status' };
  if (text === '学习通停止刷课') return { kind: 'study_stop' };
  const supplement = text.match(/^学习通答题补充\s+(\d+)\s+(\d+)\s+(.+)$/u);
  if (supplement?.[1] && supplement[2] && supplement[3]) return { kind: 'answer_supplement', jobId: Number(supplement[1]), questionPosition: Number(supplement[2]), answer: supplement[3].trim() };
  const save = text.match(/^学习通答题保存\s+(\d+)$/u);
  if (save?.[1]) return { kind: 'answer_save', jobId: Number(save[1]) };
  const submit = text.match(/^学习通答题提交\s+(\d+)$/u);
  if (submit?.[1]) return { kind: 'answer_submit', jobId: Number(submit[1]) };
  if (text === '学习通停止答题') return { kind: 'answer_stop' };
  if (text === '学习通错题') return { kind: 'wrong_answers' };
  const answer = text.match(/^学习通答题\s+(.+)$/u);
  if (answer?.[1]) return { kind: 'answer_start', courseQuery: answer[1].trim() };
  return null;
}
