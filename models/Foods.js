const mongoose = require('mongoose');

const foodsSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  calorias: Number,
  proteinas: Number,
  carbohidratos: Number,
  grasas: Number,
  porcion: String,
  createdAt: { type: Date, default: Date.now }
});

foodsSchema.index({ nombre: 'text' });

module.exports = mongoose.model('Foods', foodsSchema);
