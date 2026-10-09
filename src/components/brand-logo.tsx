/**
 * DeepAA 官方品牌标记（2026-09-05 新 LOGO 体系）：
 * 透明底 PNG 标记由 docs/logo/logo.png 裁剪生成（public/deepaa-mark.png），
 * 深浅色顶栏均适用；favicon 使用 src/app/icon.png（APP ICON 深色圆角版）。
 */
type BrandLogoProps = {
  className?: string;
  size?: number;
  title?: string;
  variant?: BrandLogoVariant;
};

export type BrandLogoVariant = "official";

export function BrandLogo({ className = "brand-logo", size = 42, title = "DeepAA Logo" }: BrandLogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={title}
      className={className}
      height={size}
      src="/deepaa-mark.png"
      width={size}
    />
  );
}
