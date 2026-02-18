const mongoose = require('mongoose');

const frequentMealSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true },
  nombre: String,
  calorias: Number,
  proteinas: Number,
  carbohidratos: Number,
  grasas: Number,
  cantidad: String,
  createdAt: { type: Date, default: Date.now }
});

frequentMealSchema.index({ telegramId: 1 });

module.exports = mongoose.model('FrequentMeal', frequentMealSchema);
