export function resolveAchievementToastY(
  commentaryVisible: boolean,
  commentaryY: number,
  commentaryHeight: number,
): number {
  return commentaryVisible ? commentaryY + commentaryHeight + 12 : 150;
}
