import appIcon from "../assets/app-icon.png";
import appIconLight from "../assets/app-icon-light.png";

/** Значок приложения (тот же, что в системе). */
export function Brand({ size = 44 }: { size?: number }) {
  return (
    <>
      <img className="brand icon-dark" src={appIcon} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
      <img className="brand icon-light" src={appIconLight} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
    </>
  );
}
