// تایپ‌های کتابخانه frog را برای رفع خطاهای index override می‌کنیم
import 'frog';

declare module 'frog' {
  namespace JSX {
    interface ButtonRootProps { index?: number; }
    interface ButtonAddCastActionProps { index?: number; }
    interface ButtonLinkProps { index?: number; }
    interface ButtonMiniAppProps { index?: number; }
    interface ButtonMintProps { index?: number; }
    interface ButtonRedirectProps { index?: number; }
    interface ButtonProps { index?: number; }
    interface ButtonTransactionProps { index?: number; }
    interface ButtonSignatureProps { index?: number; }
  }
}

// برای رفع خطای type-fest
declare module 'type-fest' {
  interface BaseType {
    [key: string | number]: any;
  }
} 