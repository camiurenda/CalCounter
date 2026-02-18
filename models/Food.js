const mongoose = require('mongoose');

const foodSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true },
  nombre: String,
  calorias: Number,
  proteinas: Number,
  carbohidratos: Number,
  grasas: Number,
  cantidad: String,
  fecha: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

foodSchema.index({ telegramId: 1, fecha: 1 });

module.exports = mongoose.model('Food', foodSchema);
