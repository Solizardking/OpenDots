declare module 'virtual:chatgptee-docs' {
  export const guide: string;
  export const article: string;
  export const routeCount: number;
  export const policies: Record<
    '/privacy' | '/terms' | '/service',
    {
      title: string;
      description: string;
      download: string;
      content: string;
    }
  >;
}
