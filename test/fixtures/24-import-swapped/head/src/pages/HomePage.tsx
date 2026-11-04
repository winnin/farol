import { Card } from '../components/FancyCard'
import { PRODUCT_KINDS } from '@/types/product'
import { t } from '@/i18n'

export default function HomePage() {
  return (
    <Card title={t('home.title')}>
      <p>{PRODUCT_KINDS.length} kinds</p>
    </Card>
  )
}
