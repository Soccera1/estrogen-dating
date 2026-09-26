export interface Profile {
  id: string;
  kind: "human" | "ai";
  name: string;
  pronouns: string;
  bio: string;
  interests: string[];
  prompt: string;
  discoverable: boolean;
  onboarded: boolean;
  preference?: string;
  avatar: string | null;
}
export interface Match {
  id: string;
  created_at: number;
  profile: Profile;
}
export interface Message {
  id: number;
  sender: string;
  body: string;
  client_id: string;
  created_at: number;
}
export interface Page<T> {
  items: T[];
  next: string | number | null;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let csrf = "";
let profile = "";
export const configure = (token: string, id: string) => {
  csrf = token;
  profile = id;
};
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      "X-Profile-ID": profile,
      "X-CSRF-Token": csrf,
      ...(options.body && typeof options.body === "string"
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data = (await response.json().catch(() => ({
    error: "Service unavailable. Your draft is safe; try again later.",
  }))) as T & { error?: string };
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error || "Something went wrong. Please retry.",
    );
  return data;
}
export async function avatarBlob(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: { "X-Profile-ID": profile },
    signal,
  });
  if (!response.ok) throw new Error("Avatar unavailable");
  return response.blob();
}
export async function resizeAvatar(file: File): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Choose an image smaller than 20 MB.");
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 768 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas
      .getContext("2d")!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.82),
    );
    if (!blob || blob.size > 524288)
      throw new Error(
        "This image is still too large. Please choose a smaller image.",
      );
    return blob;
  } finally {
    image.close();
  }
}
