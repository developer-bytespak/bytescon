// What to tell someone when an AI feature can't run because no AI key is set
// (backend answers NO_AI_KEY). An admin can fix it, so they're told where;
// anyone else is told who to ask.
export function noAiKeyMessage(isAdmin: boolean): string {
  return isAdmin
    ? 'AI isn\'t set up for this account yet. Add your AI provider key in Settings → AI Intelligence Provider.'
    : 'AI isn\'t set up for this account yet. Ask an administrator to add an AI provider key in Settings → AI Intelligence Provider.'
}
