export function secondsRemaining(item, now = Date.now()) {
  if (item.continuous) return Infinity;
  const expires = Date.parse(item.expiresAt);
  return Number.isFinite(expires)
    ? Math.max(0, Math.ceil((expires - now) / 1000))
    : 0;
}
export function canAnswer(item, connected, busy, now = Date.now()) {
  return Boolean(
    item &&
      connected &&
      !busy &&
      !item.hidden &&
      (item.receiverUntil == null || item.receiverUntil > now) &&
      secondsRemaining(item, now) > 0,
  );
}
export function recommendedOption(item) {
  const index = item.recommendedIndex;
  return Number.isInteger(index) &&
    index >= 0 &&
    index < (item.options?.length || 0)
    ? index
    : null;
}
export function initialQuestionAnswers(item) {
  return (item.questions || []).map(question => {
    const valid = (question.recommendedIndexes || []).filter((index, position, values) =>
      Number.isInteger(index) && index >= 0 && index < (question.options?.length || 0) &&
      values.indexOf(index) === position,
    );
    return {
      optionIndexes: question.multiSelect ? valid : valid.slice(0, 1),
      answer: "",
      open: false,
    };
  });
}
export function questionAnswersComplete(item, answers) {
  const questions = item?.questions || [];
  return Boolean(questions.length && Array.isArray(answers) && answers.length === questions.length &&
    questions.every((question, questionIndex) => {
      const entry = answers[questionIndex];
      if (typeof entry?.answer === "string" && entry.answer.trim()) return true;
      const selected = entry?.optionIndexes;
      return Array.isArray(selected) && selected.length > 0 && new Set(selected).size === selected.length &&
        (question.multiSelect || selected.length === 1) &&
        selected.every(index => Number.isInteger(index) && index >= 0 && index < (question.options?.length || 0));
    }));
}
export function questionAnswersVerdict(item, answers) {
  if (!questionAnswersComplete(item, answers)) return null;
  return {
    action: "answers",
    answers: answers.map(entry => entry.answer.trim()
      ? {answer: entry.answer.trim()}
      : {optionIndexes: [...entry.optionIndexes]}),
  };
}
export function expiryLabel(item, now = Date.now()) {
  if (item.receiverUntil != null && item.receiverUntil <= now) return "Terminal connection lost · waiting to reconnect. No decision can be sent.";
  if (item.continuous) return `Connected · checked ${Math.max(0, Math.floor((now - (item.receiverUntil - 30000)) / 1000))}s ago · no AgentPulse time limit`;
  const seconds = secondsRemaining(item, now);
  if (!seconds) return "Expired · continue on your computer";
  return `Expires in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
