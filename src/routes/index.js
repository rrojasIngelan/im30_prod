// Rutas de la API
const { Router } = require('express');
const pagos = require('../controllers/pagosController');
const { health } = require('../controllers/healthController');
const posCtrl = require('../controllers/posController');

const router = Router();

router.get('/health', health);
router.post('/pos/llaves', posCtrl.cargarLlaves);
router.post('/pos/cierre', posCtrl.cierre);
router.get('/pos/ultima-venta', posCtrl.ultimaVenta);

router.get('/pagos', pagos.listar);
router.post('/pagos', pagos.crear);
router.get('/pagos/:id', pagos.detalle);
router.get('/pagos/:id/watch', pagos.watch);
router.get('/pagos/:id/voucher', pagos.voucher);
router.post('/pagos/:id/voucher/imprimir', pagos.imprimirVoucher);
router.post('/pagos/:id/anular', pagos.anular);

module.exports = router;
