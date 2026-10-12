import { api } from './api';
export interface Avatar {
  id: string;
  dataUrl: string;
  prompt: string;
}
const images = new Map<string, Promise<Avatar>>();
export function loadAvatar(id: string) {
  let image = images.get(id);
  if (!image) {
    image = api<Avatar>(`/avatars/${id}`).catch((error) => {
      images.delete(id);
      throw error;
    });
    images.set(id, image);
  }
  return image;
}
export function rememberAvatar(avatar: Avatar) {
  images.set(avatar.id, Promise.resolve(avatar));
}
