// The demo site is its own build, so these checks are fixed when it's built.
export const isDemoSite = import.meta.env.VITE_APP_ENV === 'demo'

/** Words on a button or link that mean a file is moving in or out. */
export const FILE_ACTION = /\b(upload|download|export|attach|import|csv|pdf)\b/i
