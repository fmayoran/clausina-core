/** Sistema de marca ClaUsina — tokens del panel. Ver core/planes/SISTEMA_MARCA.md.
 *  Compilar: npm run build:css  (genera public/tw.css, que se commitea). */
module.exports = {
  content: ['./public/index.html', './public/maquinas.html', './public/arquitectura.html', './public/audiovisual.html', './public/proyecto.html', './public/instagram.html', './public/avisos.html', './public/landing.html', './public/perfil.html', './public/auditoria.html', './public/programacion.html', './public/shell.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // dark
        ink: '#0A0B0D', surf: '#111317', line: '#20242B', mut: '#8A8F98', fg: '#ECEEF0', sideD: '#0E1013',
        // light (capas cálidas)
        paper: '#EFEEE8', side: '#F8F7F2', psurf: '#FFFFFF', pline: '#DEDDD3', pmut: '#5A616A', pfg: '#0A0B0D',
        // acentos
        acc: '#CCF24D', accink: '#0A0B0D', cor: '#FF6A45',
      },
      fontFamily: {
        display: ['"Inter Tight"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
};
