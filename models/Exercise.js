const mongoose = require('mongoose');

const exerciseSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true },
  nombre: String,
  caloriasQuemadas: Number,
  duracion: Number,
  fecha: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

exerciseSchema.index({ telegramId: 1, fecha: 1 });

module.exports = mongoose.model('Exercise', exerciseSchema);
