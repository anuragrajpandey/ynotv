import EliteStocksTVLogo from '../assets/EliteStocksTV.svg';

interface LogoProps {
  className?: string;
  width?: number | string;
  height?: number | string;
}

export function Logo({ className, width, height }: LogoProps) {
  return (
    <img
      className={className}
      src={EliteStocksTVLogo}
      width={width}
      height={height}
      alt="EliteStocks TV"
      draggable={false}
    />
  );
}
